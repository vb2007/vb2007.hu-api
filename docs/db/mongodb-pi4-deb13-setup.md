# Installing MongoDB 4.4.18 on Raspberry Pi 4 (Debian 13 "Trixie")

This guide outlines the steps to install MongoDB Server version 4.4.18 on a Raspberry Pi 4 running Debian 13 ("Trixie") aarch64. This specific version is chosen due to compatibility with the Raspberry Pi 4's ARMv8.0-A processor, as newer MongoDB versions (5.0+) often require ARMv8.2-A or later.

## 1. System Update and Prerequisite Packages

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y gnupg curl
```

## 2. Manually Install `libssl1.1`

Debian 13 does not include `libssl1.1`, which is a dependency for MongoDB `4.4.x` from the Ubuntu 20.04 repositories. We'll download it from Debian 11 ("Bullseye").

```bash
cd /tmp
wget http://ftp.debian.org/debian/pool/main/o/openssl/libssl1.1_1.1.1w-0+deb11u1_arm64.deb
sudo dpkg -i libssl1.1_1.1.1w-0+deb11u1_arm64.deb
```

## 3. Add MongoDB 4.4 GPG Key and Repository

We will use the MongoDB repository for Ubuntu 20.04 ("Focal") as it provides ARM64 builds for version 4.4.x.

```bash
# Import the MongoDB public GPG Key for version 4.4
curl -fsSL https://pgp.mongodb.com/server-4.4.asc | \
   sudo gpg -o /usr/share/keyrings/mongodb-server-4.4.gpg \
   --dearmor

# Create the list file for MongoDB 4.4
echo "deb [ arch=arm64 signed-by=/usr/share/keyrings/mongodb-server-4.4.gpg ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/4.4 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-4.4.list
```

## 4. Install Specific MongoDB 4.4.18 Packages

Refresh package lists and install MongoDB 4.4.18.

```bash
sudo apt update

# Install MongoDB 4.4.18 and its specific components
sudo apt install -y mongodb-org=4.4.18 mongodb-org-server=4.4.18 mongodb-org-shell=4.4.18 mongodb-org-mongos=4.4.18 mongodb-org-tools=4.4.18
```

### Hold MongoDB Packages

Prevent accidental upgrades to newer, potentially incompatible versions.

```bash
sudo apt-mark hold mongodb-org mongodb-org-server mongodb-org-shell mongodb-org-mongos mongodb-org-tools
```

## 5. Start, Enable, and Verify MongoDB Service

```bash
sudo systemctl daemon-reload
sudo systemctl start mongod
sudo systemctl enable mongod

# Check the service status
sudo systemctl status mongod
```

You should see Active: active (running). If not, check logs:

```bash
journalctl -u mongod -n 50 --no-pager
cat /var/log/mongodb/mongod.log
```

## 6. Test MongoDB Connection

Use the `mongo` shell (note: `mongosh` is for MongoDB 5.0+).

```bash
mongo --eval 'db.runCommand({ connectionStatus: 1 })'
```

You should see a successful connection message with `"ok" : 1`.
