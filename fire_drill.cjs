const fs = require('fs');

async function runLoadTest() {
    console.log("Reading synthetic_splunk_alerts.csv...");
    const csv = fs.readFileSync('synthetic_splunk_alerts.csv', 'utf8');
    const lines = csv.split('\n').slice(1).filter(line => line.trim() !== '');
    
    console.log(`Firing ${lines.length} concurrent webhooks at the Conductor...`);
    
    let sent = 0;
    let accepted = 0;

    // Fire all requests asynchronously to simulate a massive JMeter thread group
    const requests = lines.map(async (line) => {
        const [timestamp, source, severity, message] = line.split(',');
        
        const payload = { timestamp, source, severity, message };
        
        try {
            sent++;
            const response = await fetch('http://127.0.0.1:8080/api/v1/workspace/ingest', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    // The zero-trust bypass token
                    'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJsb2NhbC1kZXYtdXNlciIsInJvbGUiOiJJbmNpZGVudCBDb21tYW5kZXIiLCJleHAiOjI1MjQ2MDgwMDB9.mock-signature-bypass'
                },
                body: JSON.stringify(payload)
            });
            
            if (response.status === 202) accepted++;
        } catch (err) {
            console.error("Connection failed:", err.message);
        }
    });

    await Promise.all(requests);
    console.log(`\nFIRE DRILL COMPLETE.`);
    console.log(`Sent: ${sent}`);
    console.log(`202 Accepted: ${accepted}`);
}

runLoadTest();