# Running the application in production mode

> [!NOTE]
> This documentation is written for setting up the app on a Debian Linux server. Some commands will vary on different operating systems.

## Config values in .env

Create the `.env` file in the project's root directory:

```shell
cp .env.example .env
nano .env
```

Set the required environment variables:

- `APP_IP=` : the ip address the application will run on (usually `localhost`)
- `APP_PORT=` : the port the application will run on (can be any valid port, I've used `3000`)
- `CORS_ORIGIN_URLS=` : a list of URLs seperated with `,`s that are allowed to access the API (e.g. `http://localhost:3000,http://api.example.com`)
- `DB_CONNECTION_STRING=` : a valid connection string for a MongoDB database

## Installing, building and running the application

After setting up the `.env` file, install the application's dependencies:

```shell
npm install
```

Then build the application with:

```shell
npm run build
```

*Can be skipped if you will run the application as a systemd service.*

Finally, run the application with:

```shell
npm run prod
```

## Running the application in the background

For Linux systems, there is a [vb2007hu-api.service](../production/vb2007hu-api.service) file in the project with an example configuration for running this service in the background.

Edit the relevant lines in the file (you can leave the rest as-is), then save the changes:

```service
...
WorkingDirectory=/path/to/the/projects/folder
...
User=your-user
Group=your-group
...
```
