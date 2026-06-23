# Running the application in production mode

> [!IMPORTANT]
> This documentation is written for setting up the app on a Debian Linux server. Some commands will vary on different operating systems.

## Config variables in .env

Refer to [dotenv-setup](./dotenv-setup.md).

## Installing, building and running the application

Install Node.js runtime and the yarnpkg package manager, if you haven't already:

```shell
sudo apt update
sudo apt install nodejs yarnpkg
```

Install the application's dependencies:

```shell
yarnpkg install
```

Then build the application with:

```shell
yarnpkg run build
```

Finally, run the application with:

*Can be skipped if you will run the application as a systemd service.*

```shell
yarnpkg run prod
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

Reload systemd:

```shell
sudo systemctl daemon-reload
```

Start the service:

```shell
sudo systemctl start vb2007hu-api.service
```

(Optional) Enable the service to start it on boot:

```shell
sudo systemctl enable vb2007hu-api.service
```

> [!TIP]
> For other background process managing commands, please refer to systemd's [manpages documentation](https://manpages.org/systemd) or [systemd.io](https://systemd.io/).

## Setting up a Nginx reverse proxy

Install Nginx, if you haven't already:

```shell
sudo apt update
sudo apt install nginx
```

Make sure it's default configuration (located at: `/etc/nginx/nginx.conf`) includes every config file in the `conf.d` directory:

```conf
...
include /etc/nginx/modules-enabled/*.conf;
...
```

Create a new file named `vb2007hu-api.conf`:

```shell
sudo nano /etc/nginx/conf.d/vb2007hu-api.conf
```

And paste [this](../production/vb2007-api.conf) file's content into it. Modify it as needed.

Restart and (*optional*) enable the service:

```shell
sudo systemctl restart nginx
sudo systemctl enable nginx
```

## App is production ready

After configuring, building, setting up the systemd service and the Nginx reverse proxy, the application should be ready for requests.
