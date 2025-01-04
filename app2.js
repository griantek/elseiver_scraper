require('dotenv').config(); // Load environment variables from .env file
const fetch = require('node-fetch'); // Use CommonJS syntax for importing node-fetch
const sqlite3 = require('sqlite3').verbose();
const JournalScraper = require('./JournalScraper.js');

const maxRetries = 1;
const initialDelay = 1000;
const backoffFactor = 2;

async function fetchWithRetry(url, options, retries = 0) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const errorDetails = await response.text();
            console.error(`HTTP error! status: ${response.status}, details: ${errorDetails}`);
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response;
    } catch (error) {
        if (retries < maxRetries) {
            const delay = initialDelay * Math.pow(backoffFactor, retries);
            console.log(`Retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return fetchWithRetry(url, options, retries + 1);
        } else {
            console.error(`Failed after ${maxRetries} retries with error:`, error.message);
            throw error;
        }
    }
}

async function fetchAllPages() {
    const scraper = new JournalScraper('elsevier_journals.db'); // Assuming the same db name as used in JournalScraper
    const baseUrl = 'https://www.elsevier.com/api/search/journal-catalog-search';
    const totalPages = 316;
    let totalJournals = 0;
    let processedJournals = 0;

    for (let page = 105; page <= 211; page++) {
        const postData = {
            query: "",
            page: page,
            filters: {
                acceptanceRateLte: null,
                acceptanceRateGte: null,
                citeScoreLte: null,
                citeScoreGte: null,
                impactFactorLte: null,
                impactFactorGte: null,
                timeToFirstDecisionLte: null,
                timeToFirstDecisionGte: null,
                accessType: null,
                subjectAreas: null
            },
            sort: "alphabeticalAsc"
        };

        try {
            const response = await fetchWithRetry(baseUrl, {
                method: 'POST',
                headers: {
                    'Host': 'www.elsevier.com',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate, br, zstd',
                    'Referer': `https://www.elsevier.com/products/journals?sortBy=alphabeticalAsc&page=${page}`,
                    'Content-Type': 'text/plain;charset=UTF-8',
                    'Origin': 'https://www.elsevier.com',
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin'
                },
                body: JSON.stringify(postData)
            });

            const data = await response.json();

            if (data.searchResponse && data.searchResponse.items) {
                for (const journal of data.searchResponse.items) {
                    let shopUrl = journal.journalLinks?.productDetailPageURL || 'N/A';
                    if (shopUrl !== 'N/A') {
                        // Check if the journal title already exists in the database
                        const journalTitle = scraper.extractJournalTitleFromUrl(shopUrl);
                        const existingJournalId = await new Promise((resolve, reject) => {
                            const checkQuery = `SELECT id FROM journal_details WHERE journal_title = ?`;
                            scraper.db.get(checkQuery, [journalTitle], (err, row) => {
                                if (err) {
                                    return reject(err);
                                }
                                if (row) {
                                    // Journal title already exists, skip processing
                                    console.log(`Journal title "${journalTitle}" already exists. Skipping processing.`);
                                    return resolve(row.id);
                                } else {
                                    return resolve(null);
                                }
                            });
                        });

                        if (existingJournalId) {
                            continue; // Skip processing if the journal already exists
                        }

                        try {
                            // Use JournalScraper to handle all the detailed scraping
                            const id = await scraper.processJournal(shopUrl);
                            totalJournals++;
                            processedJournals++;
                            console.log(`Processed journal: ${journal.titles?.primary || 'N/A'} (ID: ${id})`);
                        } catch (error) {
                            console.error(`Error processing journal from ${shopUrl}:`, error.message);
                            continue; // Retry the current page
                        }
                    }
                }
            }
            console.log(`Processed page ${page} - Total journals added so far: ${totalJournals}`);
        } catch (error) {
            console.error(`Error processing page ${page}:`, error.message);
        }

        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await scraper.close(); // Close the database connection
    return totalJournals;
}

try {
    const totalProcessed = await fetchAllPages();
    console.log(`All data fetched and stored in database. Total journals processed: ${totalProcessed}`);
} catch (error) {
    console.error('Failed to fetch and store all pages:', error);
}