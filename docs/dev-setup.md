# Running the application for development

## Config values in .env

Create the `.env` file in the project's root directory:

```shell
cp .env.example .env
nano .env
```

Set the required environment variables:

- `APP_IP=` : the ip address the application will run on (usually `localhost`)
- `APP_PORT=` : the port the application will run on (can be any valid port, I've used `3000`)
- `CORS_ORIGIN_URLS=` : a list of URLs seperated with `,`s that are allowed to access the API (e.g. `http://localhost:5173,http://api.example.com`)
- `DB_CONNECTION_STRING=` : a valid connection string for a MongoDB database

## Installing dependecies and modifying the code

After setting up the `.env` file, install the application's dependencies:

```shell
npm install
```

Open the project or any of it's files in any code editor, and start the application with:

```shell
npm start
```
