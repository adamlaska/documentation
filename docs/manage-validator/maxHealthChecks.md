---
id: maxHealthChecks
title: Enhance Validator Reliability maxHealthChecks
sidebar_label: Validator reliability maxHealthChecks
---

In the ever-evolving landscape of Ethereum infrastructure, maintaining robust and reliable validator operations is paramount. Validators play a crucial role in securing the network, proposing blocks, and verifying the state of the chain. However, challenges like beacon node unavailability or connectivity issues can disrupt these operations, leading to potential downtime or unsafe behaviors. To address such concerns, we introduce a significant improvement for safer validator shutdowns and restarts, with a key highlight being the new `maxHealthChecks` configuration. These changes underwent rigorous testing using tools such as Kurtosis, simulating scenarios such as beacon node failures and recoveries to verify graceful handling without panics or indefinite hangs.

## What is maxHealthChecks?
At its core, `maxHealthChecks` is a configurable parameter that defines the maximum number of health check attempts the validator client will perform on the connected beacon node(s) before deeming the connection timed out and proceeding to shutdown. It's accessible via a command-line flag (`--max-health-checks`) and stored as an integer variable in the validator's runtime configuration.

- **Default Behavior**: By default, the flag is 0, which represents indefinite checks—meaning the client will keep trying until the node recovers or manual intervention occurs.
- **Positive Values**: Any positive integer sets a hard limit on attempts, providing a safety net against prolonged unresponsiveness.
- **Implementation Snippet**: In the updated `validator/client/runner.go`, the logic is straightforward:

```go
 if maxHealthChecks != -1 && healthCheckCounter >= maxHealthChecks {
 log.Info("Health check timed out")
 cancel()  // Initiates context cancellation for shutdown
 }
```

Here, `healthCheckCounter` increments with each failed check, and upon reaching the threshold, the client logs the timeout and cancels its context, allowing for a graceful shutdown or restart.

This feature builds on Prysm's existing health monitoring, which periodically pings the beacon node to ensure it's synced, responsive, and capable of handling validator duties, such as attestation and block proposal.

## Purpose and Benefits

The introduction of `maxHealthChecks` stems from real-world pain points in validator operations:
- **Preventing Indefinite Hanging**: Without a limit, a validator might loop endlessly during beacon node outages, consuming resources and delaying recovery actions.
- **Improved Reliability**: By allowing configurable timeouts, operators can tailor the client's patience to their setup—e.g., shorter limits for high-availability clusters with quick failovers.
- **Safe Shutdowns and Restarts**: Upon timeout, the validator shuts down gracefully, preserving state and enabling automated restarts (e.g., via systemd or Docker orchestration). This timeout is particularly useful in distributed environments where beacon nodes might experience transient failures.
- **Bug Fixes and Compatibility**: It resolves issues like improper fallback to secondary nodes when features like doppelganger protection are enabled, and it plays nicely with advanced setups involving load-balanced gRPC connections.

Overall, this enhances the resilience of Prysm validators, reducing the risk of missed duties and slashing penalties while making the client more operator-friendly.

## How It Works Under the Hood

The `maxHealthChecks` logic is present in the validator's health monitoring loop:
1. **Initialization**: When starting the validator (e.g., via `bazel run //cmd/validator:validator`), the flag value is parsed and assigned to `maxHealthChecks`.
2. **Health Monitoring**: The new `healthMonitor` component runs in the background, performing periodic checks (e.g., via gRPC or HTTP endpoints) on the beacon node's status.

:::caution Caution

- **gRPC**: If you provide multiple hosts and it connects to the first, it will fall back to the second. If the second host attempt fails, it will fall back to the first host. However, if the first host doesn't work again, it will not attempt the second again.
- **REST**: It will continually round-robin between hosts, until all retries are exhausted (if set to 0, it will attempt indefinitely).

:::

3. **Counter Management**: Each failed check increments `healthCheckCounter`. Successful checks reset it.
4. **Threshold Check**: If the counter hits the `maxHealthChecks` limit (and it's not 0), the monitor triggers a shutdown by canceling the validator's context.
5. **Recovery**: Post-shutdown, operators can restart the validator, which will attempt reconnection. Tests in the PR confirm that upon beacon node recovery, the validator resumes duties seamlessly.

This mechanism is non-disruptive during regular operation and only activates in the event of prolonged issues, ensuring minimal impact on performance.

## How to Use maxHealthChecks: A Step-by-Step Guide

### Prerequisites
1. **Prysm Installed**: Ensure you have Prysm installed. You can install it using Docker, build from source using Bazel, or use precompiled binaries. Refer to the Prysm documentation for [installation instructions](/install-prysm/install-with-script.md).
2. **Access to Configuration**: You should have access to configure Prysm’s beacon node and validator client, either via command-line flags, a configuration file, or environment variables.
3. **Understanding of gRPC and REST**: The `maxHealthChecks` flag applies to Prysm’s beacon node connections, which can use gRPC (default) or REST (via the beacon API) to communicate with the validator client or other services.

### Step 1: Configure the Beacon Node
The `maxHealthChecks` flag is a beacon node configuration option. You can set it via command-line flags, a configuration file, or environment variables.

#### Option 1: Command-Line Flag
1. Start the beacon node with the `--max-health-checks` flag:
   ```bash
   ./bazel-bin/cmd/beacon-chain/beacon-chain --max-health-checks=10
   ```
   - Replace `10` with your desired number of consecutive failed health checks (e.g., `3` for stricter reconnection or `20` for more tolerance).
   - This flag applies to both gRPC and REST connections managed by the beacon node.

2. If using Docker, add the flag to the Docker run command:
   ```bash
   docker run -it -v $HOME/prysm-data:/data -p 4000:4000 -p 13000:13000 gcr.io/offchainlabs/prysm-beacon-chain:latest --max-health-checks=10
   ```

#### Option 2: Configuration File
1. Create or edit a Prysm configuration file (e.g., `config.yml`):
   ```yaml
   max-health-checks: 10
   ```
2. Start the beacon node with the configuration file:
   ```bash
   ./bazel-bin/cmd/beacon-chain/beacon-chain --config-file=config.yml
   ```
   Or with Docker:
   ```bash
   docker run -it -v $HOME/prysm-data:/data -v $HOME/config.yml:/config.yml gcr.io/offchainlabs/prysm-beacon-chain:latest --config-file=/config.yml
   ```

#### Option 3: Environment Variable
1. Set the environment variable for `maxHealthChecks`:
   ```bash
   export MAX_HEALTH_CHECKS=10
   ```
2. Start the beacon node:
   ```bash
   ./bazel-bin/cmd/beacon-chain/beacon-chain
   ```
   Or with Docker:
   ```bash
   docker run -it -e MAX_HEALTH_CHECKS=10 -v $HOME/prysm-data:/data gcr.io/offchainlabs/prysm-beacon-chain:latest
   ```


### Step 2: Configuration
#### Configure for gRPC
- **Default Behavior**: Prysm uses gRPC for communication between the beacon node and validator client unless REST mode is explicitly enabled.
- **Steps**:
  1. Ensure the beacon node is running with the `--max-health-checks` flag or configuration as set above.
  2. Start the validator client, connecting to the beacon node:
     ```bash
     ./bazel-bin/cmd/validator/validator --beacon-rpc-provider=localhost:4000
     ```
     Or with Docker:
     ```bash
     docker run -it -v $HOME/prysm-data:/data gcr.io/offchainlabs/prysm-validator:latest --beacon-rpc-provider=localhost:4000
     ```
  3. The `maxHealthChecks` setting on the beacon node will govern how many failed gRPC health checks (e.g., to `localhost:4000`) are allowed before the connection is marked unhealthy.

#### Configure for REST
- **Enable REST Mode**: To use REST instead of gRPC, configure the beacon node to enable the HTTP API and the validator to use REST endpoints.
- **Steps**:
  1. Start the beacon node with the REST API enabled and the `maxHealthChecks` flag:
     ```bash
     ./bazel-bin/cmd/beacon-chain/beacon-chain --http-web3provider=http://localhost:8545 --enable-beacon-rest-api --max-health-checks=10
     ```
     Or with Docker:
     ```bash
     docker run -it -v $HOME/prysm-data:/data -p 4000:4000 -p 13000:13000 gcr.io/offchainlabs/prysm-beacon-chain:latest --http-web3provider=http://localhost:8545 --enable-beacon-rest-api --max-health-checks=10
     ```
     - The `--enable-beacon-rest-api` flag enables the REST API.
     - The `--http-web3provider` specifies the execution client endpoint (e.g., Geth or Nethermind).
  2. Start the validator client in REST mode:
     ```bash
     ./bazel-bin/cmd/validator/validator --beacon-rest-api-provider=http://localhost:3500
     ```
     Or with Docker:
     ```bash
     docker run -it -v $HOME/prysm-data:/data gcr.io/offchainlabs/prysm-validator:latest --beacon-rest-api-provider=http://localhost:3500
     ```
     - The `--beacon-rest-api-provider` specifies the beacon node’s REST API endpoint (default port is 3500).
  3. The `maxHealthChecks` setting will control how many failed REST health checks are allowed before the connection is considered unhealthy.

### Step 3: Monitor and Test
1. **Monitor Logs**: Check the beacon node logs for health check-related messages. Look for errors indicating failed health checks or connection retries:
   ```bash
   docker logs <beacon-node-container>
   ```
   Or, if running locally:
   ```bash
   tail -f /path/to/beacon-node.log
   ```
2. **Simulate Failures**: To test the `maxHealthChecks` behavior, temporarily disrupt the connection (e.g., stop the execution client or block the gRPC/REST port) and observe if the beacon node reconnects after the specified number of failed health checks.
3. **Metrics**: Use Prysm’s monitoring tools (e.g., Prometheus and Grafana) to track connection health:
   - Configure [Prometheus and Grafana](/monitoring-alerts-metrics/grafana-dashboard.md).
   - Look for metrics related to gRPC or REST connection status.

### Step 4: Adjust `maxHealthChecks` as Needed
- **Tuning**: If you experience frequent disconnections, increase the `maxHealthChecks` value (e.g., to 15 or 20) to make the system more tolerant of temporary failures. If you want faster failover, decrease it (e.g., to 3 or 5).
- **Example**:
   ```bash
   ./bazel-bin/cmd/beacon-chain/beacon-chain --max-health-checks=15
   ```
- **Restart**: After changing the flag, restart the beacon node to apply the new setting.

### Step 5: Troubleshooting
- **Common Issues**:
  - If the beacon node fails to start, check for errors like “could not process slots” or “503 Service Unavailable,” which may indicate execution client sync issues. Ensure that you fully synchronize your execution client (such as Geth).
  - If REST endpoints fail, verify that `--enable-beacon-rest-api` is set and the correct port is open (default 3500).
  - For gRPC issues, ensure the `--beacon-rpc-provider` points to the correct host and port (default 4000).
- **Logs**: Review logs for health check failures or connection issues.
- **Community Support**: If you encounter issues, join the [Prysm Discord](https://discord.com/invite/prysm) community for support.

If prysm-node fails, the validator attempts eight health checks (e.g., ~40-80 seconds) before switching to lighthouse-node. Upon timeout, it shuts down gracefully, allowing Kubernetes to restart it and reconnect to an available node.

## Conclusion
The `--max-health-checks` and `--beacon-rest-api-provider` flags significantly enhance validator reliability by preventing hangs during beacon node failures and enabling flexible, interoperable connections via the Ethereum REST API. These features empower operators to build robust staking setups, whether solo or in complex cloud environments. As Ethereum continues to scale, such improvements ensure that validators remain a cornerstone of network security.