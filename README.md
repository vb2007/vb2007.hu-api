# vb2007.hu-api

## About

A simple API for my personal website, written with Express.js and some other packages.

This project was made for replacing the first version of my site that was written in PHP for some weird, masochist reason: [vb2007.hu-php](https://github.com/vb2007/vb2007.hu-php)

## Setting up the application

### General setup

**A MongoDB database is required for running the application.**

1. Clone the repository.
2. Create a .env file, or rename the existing .env.example file and fill out the required data.
3. Install Node.js dependencies with the `npm i` command.

### Running the application

To start the application, simply execute the `npm start` command.

#### Running it in the background

If you're using a Linux system, there is a [vb2007hu-api.service](./src/systemd/vb2007hu-api.service) file in the project with an example configuration for running this service in the background.

##### Setup steps

Make a new `vb2007hu-api.service` file based on the example file linked above:

```shell
sudo nano /etc/systemd/system/vb2007hu-api.service
```

Edit the relevant lines in the file (you can leave the rest as-is), then save the changes:

```service
...
WorkingDirectory=/path/to/the/projects/folder
...
User=your-user
Group=your-group
...
```

Reload systemd:

```shell
sudo systemctl daemon-reload
```

Start the service:

```shell
sudo systemctl start vb2007hu-api.service.service
```

(Optional) Enable the service to start on boot:

```shell
sudo systemctl enable vb2007hu-api.service.service
```

If you want to know other things about doing stuffs with the background service, please refer to systemd's [manpages documentation](https://manpages.org/systemd) or [systemd.io](https://systemd.io/).
