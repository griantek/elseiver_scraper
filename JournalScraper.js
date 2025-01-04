const { JSDOM } = require('jsdom');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios'); // Add axios for HTTP requests
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const fs = require('fs');
const { performance } = require('perf_hooks'); // Add performance API

class JournalScraper {
    constructor(dbPath = 'journal_details.db') {
        console.log('Initializing journal scraper...');
        this.db = new sqlite3.Database(dbPath);
        this.setupDatabase();
        this.apiKeys = process.env.SCRAPERAPI_KEYS.split(','); // Load API keys from environment variable
        this.currentApiKeyIndex = 0;
    }

    async setupDatabase() {
        return new Promise((resolve, reject) => {
            this.db.run(`
                CREATE TABLE IF NOT EXISTS journal_details (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    journal_title TEXT,
                    aims_and_scope TEXT,
                    issn TEXT,
                    subject_areas TEXT,
                    impact_factor TEXT,
                    cite_score REAL,
                    apc REAL,
                    time_to_first_decision INTEGER,
                    review_time INTEGER,
                    submission_to_acceptance INTEGER,
                    acceptance_to_publication INTEGER,
                    acceptance_rate REAL,
                    abstracting_indexing TEXT,
                    shop_url TEXT,
                    sciencedirect_url TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    extractJournalTitleFromUrl(shopUrl) {
        const match = shopUrl.match(/journals\/([^\/]+)/);
        return match ? match[1] : null;
    }

    buildScienceDirectUrl(journalTitle, endpoint = 'about/insights') {
        return `https://www.sciencedirect.com/journal/${journalTitle}/${endpoint}`;
    }

    async fetchWithRetry(url, options = {}, retries = 3) {
        const getApiKey = () => this.apiKeys[this.currentApiKeyIndex];
        const switchApiKey = () => {
            this.currentApiKeyIndex = (this.currentApiKeyIndex + 1) % this.apiKeys.length;
            console.log(`Switching to API key: ${getApiKey()}`);
        };

        for (let i = 0; i < retries; i++) {
            const apiKey = getApiKey();
            const apiUrl = `https://api.scraperapi.com/?api_key=${apiKey}&url=${encodeURIComponent(url)}&render=true&retry_404=true&country_code=us&max_cost=5000&keep_headers=true`;
            console.log(`Fetching ${url} with API key: ${apiKey}...`);

            const startTime = performance.now(); // Start timer
            try {
                const response = await axios.get(apiUrl);
                const endTime = performance.now(); // End timer
                console.log(`Fetched ${url} successfully in ${(endTime - startTime).toFixed(2)} ms`);
                return { ok: true, text: async () => response.data };
            } catch (error) {
                const endTime = performance.now(); // End timer
                console.log(`Failed to fetch ${url} in ${(endTime - startTime).toFixed(2)} ms`);
                if (error.response) {
                    const status = error.response.status;
                    if (status === 401) {
                        console.error('Unauthorized request, switching to next API key.');
                        switchApiKey();
                    } else if (status === 403) {
                        console.error('API key quota exceeded, switching to next API key.');
                        switchApiKey();
                    } else if (status === 429) {
                        console.error('Too many requests, retrying after delay.');
                        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
                    } else if (status === 500) {
                        console.error('Server error, retrying after delay.');
                        await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
                    } else {
                        console.error(`HTTP error! status: ${status}`);
                        if (i === retries - 1) {
                            return { ok: false, text: async () => '' };
                        }
                    }
                } else {
                    console.error('Network error, retrying after delay.');
                    await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
                }
            }
        }
        return { ok: false, text: async () => '' };
    }

    async getAimsAndScope(journalTitle) {
        const url = this.buildScienceDirectUrl(journalTitle, 'about/aims-and-scope');
        const response = await this.fetchWithRetry(url);
        if (!response.ok) {
            console.error(`Skipping aims and scope for ${journalTitle} due to fetch error`);
            return null;
        }
        const html = await response.text();
        const dom = new JSDOM(html);
        const aimsSection = dom.window.document.querySelector('.js-aims-and-scope');
        return aimsSection ? aimsSection.textContent.trim() : null;
    }

    parseInsightsPage(dom) {
        const document = dom.window.document;

        // Helper function to extract metrics
        const getMetricValue = (label) => {
            const metricBox = Array.from(document.querySelectorAll('.metric-box')).find(box =>
                box.textContent.includes(label)
            );
            return metricBox ? parseFloat(metricBox.querySelector('.text-xl').textContent) : null;
        };

        const subjectAreasDiv = Array.from(document.querySelectorAll('.row.gutters.hor-line.u-padding-l-ver')).find(div =>
            div.querySelector('h3')?.textContent.trim() === 'Subject areas'
        );
        const subject_areas = subjectAreasDiv ? subjectAreasDiv.querySelector('.col-lg-17.col-xs-24.text-s')?.textContent.trim() : 'N/A';


        return {
            issn: document.querySelector('.col-lg-17.col-xs-24 .u-display-inline')?.textContent.trim(),
            subject_areas: subject_areas,
            cite_score: getMetricValue('CiteScore'),
            apc: parseFloat(document.querySelector('.list-price-without-waiver .text-xl')?.textContent.replace('$', '').replace(',', '')),
            time_to_first_decision: getMetricValue('Time to first decision'),
            review_time: getMetricValue('Review time'),
            submission_to_acceptance: getMetricValue('Submission to acceptance'),
            acceptance_to_publication: getMetricValue('Acceptance to publication'),
            impact_factor: getMetricValue('Impact Factor'),
            acceptance_rate: getMetricValue('Acceptance Rate'),
            abstracting_indexing: Array.from(document.querySelectorAll('.abstracts-and-indexing li'))
                .map(li => li.textContent.trim())
                .join(', ')
        };
    }

    async scrapeJournalData(shopUrl) {
        const journalTitle = this.extractJournalTitleFromUrl(shopUrl);
        if (!journalTitle) throw new Error('Could not extract journal title from URL');

        const [scienceDirectUrl, aimsAndScope] = await Promise.all([
            this.buildScienceDirectUrl(journalTitle),
            this.getAimsAndScope(journalTitle)
        ]);

        // Fetch insights page
        const insightsResponse = await this.fetchWithRetry(scienceDirectUrl);
        const insightsHtml = await insightsResponse.text();
        const insightsDom = new JSDOM(insightsHtml);
        const insightsData = this.parseInsightsPage(insightsDom);

        return {
            journal_title: journalTitle,
            aims_and_scope: aimsAndScope,
            ...insightsData,
            shop_url: shopUrl,
            sciencedirect_url: scienceDirectUrl
        };
    }

    async saveJournalData(data) {
        return new Promise((resolve, reject) => {
            const checkQuery = `SELECT id FROM journal_details WHERE journal_title = ?`;
            this.db.get(checkQuery, [data.journal_title], (err, row) => {
                if (err) {
                    return reject(err);
                }
                if (row) {
                    // Journal title already exists, skip insertion
                    console.log(`Journal title "${data.journal_title}" already exists. Skipping insertion.`);
                    return resolve(row.id);
                } else {
                    const columns = Object.keys(data).join(', ');
                    const placeholders = Object.keys(data).map(() => '?').join(', ');
                    const values = Object.values(data);
                    this.db.run(
                        `INSERT INTO journal_details (${columns}) VALUES (${placeholders})`,
                        values,
                        function (err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(this.lastID || null);
                            }
                        }
                    );
                }
            });
        });
    }

    async processJournal(shopUrl) {
        try {
            const data = await this.scrapeJournalData(shopUrl);
            const id = await this.saveJournalData(data);
            console.log(`Successfully processed journal: ${data.journal_title} (ID: ${id})`);
            return id;
        } catch (error) {
            console.error(`Error processing journal ${shopUrl}:`, error);
            throw error;
        }
    }

    close() {
        return new Promise((resolve, reject) => {
            this.db.close(err => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

module.exports = JournalScraper;