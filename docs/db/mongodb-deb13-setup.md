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

## 4. Authentication & admin user creation

Open the MongoDB shell:

```bash
mongosh
```

Create an admin user:

```js
use admin

db.createUser({
  user: "adminUser",
  pwd: "StrongPassword123!",
  roles: [{ role: "userAdminAnyDatabase", db: "admin" }, "readWriteAnyDatabase"]
})

exit
```

## 5. Configuration

Open MongoDB's configuration file:

```bash
sudo nano /etc/mongod.conf
```

Find the `security:` section and set:

```bash
security:
  authorization: enabled
```

(Optional) Enable remote connections.

Find the `net` section and set:

```bash
net:
  bindIp: 0.0.0.0
```

After saving the changes, restart MongoDB:

```bash
sudo systemctl restart mongod
```

## 6. Database & general user creation

Connect as admin:

```bash
mongosh -u adminUser -p StrongPassword123! --authenticationDatabase admin
```

Create the database & a dedicated user for it:

```js
use vb2007hu-api

db.createUser({
  user: "apiUser",
  pwd: "AppPassword456!",
  roles: [{ role: "readWrite", db: "vb2007hu-api" }]
})

// Optional: insert a document so the DB is actually created on disk + for testing it works
db.testCollection.insertOne({ status: "ready" })

exit
```

## 7. Creating a connection string

Using the actual details you've configured above, fill in the following details to get a connection string:

```txt
mongodb://apiUser:AppPassword456!@192.168.x.x:27017/vb2007hu-api?authSource=vb2007hu-api
```