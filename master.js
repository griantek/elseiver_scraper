const { spawn } = require('child_process');

function runScript(scriptPath) {
    return new Promise((resolve, reject) => {
        const process = spawn('node', [scriptPath]);

        process.stdout.on('data', (data) => {
            console.log(`[${scriptPath}] ${data}`);
        });

        process.stderr.on('data', (data) => {
            console.error(`[${scriptPath}] ${data}`);
        });

        process.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Script ${scriptPath} exited with code ${code}`));
            } else {
                resolve();
            }
        });
    });
}

async function runAllScripts() {
    try {
        await Promise.all([
            runScript('./app1.js'),
            runScript('./app2.js'),
            runScript('./app3.js')
        ]);
        console.log('All scripts completed successfully.');
    } catch (error) {
        console.error('Error running scripts:', error);
    }
}

runAllScripts();
