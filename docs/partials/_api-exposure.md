:::danger Do not expose these APIs to the internet

The commands below set `--rpc-host=0.0.0.0`, `--http-host=0.0.0.0`, and `--monitoring-host=0.0.0.0` so the beacon node's APIs are reachable across the Docker network bridge. These bind the gRPC (`4000`), HTTP (`3500`), and monitoring APIs to **all interfaces**, not just localhost.

These APIs are **not authenticated** and [must not be publicly exposed](/apis/ethereum-beacon-node-api.md). Anyone who can reach them can query your node and change proposer settings such as the fee recipient, redirecting your block priority-fee ("tip") earnings to an attacker-controlled address.

Only run with `0.0.0.0` when the container's published ports are protected by your host firewall. As covered in [Configure ports and firewalls](/manage-connections/configure-ports-and-firewalls.md), block inbound traffic to ports `3500` and `4000` from the outside world, and expose them only to trusted hosts (for example, a remote validator client) over a private network or SSH tunnel.

:::