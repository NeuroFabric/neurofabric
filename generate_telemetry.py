import pandas as pd
import numpy as np
from datetime import datetime, timedelta

# Configuration for the synthetic dataset
NUM_RECORDS = 10000
SEVERITY_LEVELS = ["WARNING", "CRITICAL", "INFO", "FATAL"]
SOURCES = ["splunk_network_monitor", "appdynamics_apm", "k8s_kubelet", "db_query_analyzer"]
MESSAGES = [
    "OOMKilled: memory limit exceeded",
    "High CPU utilization detected on worker node",
    "Connection timeout reaching primary database",
    "Unusual spike in HTTP 500 responses",
    "Pod crashloop backoff state detected"
]

# Generate random timestamps over the last 24 hours
base_time = datetime.now()
timestamps = [base_time - timedelta(minutes=np.random.randint(0, 1440)) for _ in range(NUM_RECORDS)]

# Build the dataset
data = {
    "timestamp": [t.isoformat() + "Z" for t in timestamps],
    "source": np.random.choice(SOURCES, NUM_RECORDS),
    "severity": np.random.choice(SEVERITY_LEVELS, NUM_RECORDS, p=[0.4, 0.15, 0.4, 0.05]),
    "message": np.random.choice(MESSAGES, NUM_RECORDS),
    "execution_time_ms": np.random.normal(loc=120, scale=35, size=NUM_RECORDS).astype(int)
}

df = pd.DataFrame(data)

# Sort chronologically
df = df.sort_values(by="timestamp", ascending=True)

# Export to CSV for the load testing harness
output_file = "synthetic_splunk_alerts.csv"
df.to_csv(output_file, index=False)

print(f"Successfully generated {NUM_RECORDS} synthetic telemetry events in {output_file}")