# Installing MongoDB on a Debian 13 server

This guide outlines the steps to install MongoDB Server on a general server running Debian 13 / 13.5.

> [!WARNING]
> This setup provides a working MongoDB Server instance on a general Debian 13 server. It's been tested only on one singular machine, but should work on most Debian 13 / 13.5 setups. 

## 1. Checking if your system meets MongoDB's requirements

Confirm your CPU supports AVX, as MongoDB 5.0+ requires it:

```bash
grep avx /proc/cpuinfo | head -1
```

If you see any output, it most likely means your hardware meets MongoDB's requirements.

## 2. Preparing for installation

Update the system and install prerequisites:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl gnupg
```

Import the official MongoDB GPG signing key:

```bash
curl -fsSL https://pgp.mongodb.com/server-8.0.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/mongodb-server-8.0.gpg
```

Add the MongoDB repository:

```bash
echo "deb [signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg] \
  https://repo.mongodb.org/apt/debian bookworm/mongodb-org/8.0 main" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-8.0.list
```

## 3. Installing MongoDB 8.0

Install MongoDB with the following commands:

```bash
sudo apt update
sudo apt install -y mongodb-org
```

Start and enable its systemd service:

```bash
sudo systemctl start mongod
sudo systemctl enable mongod
sudo systemctl status mongod
```