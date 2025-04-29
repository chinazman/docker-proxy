# Docker Registry Proxy (Node.js Version)

[English](./README.md) | [简体中文](./README.zh-CN.md)

This project provides a Node.js application that acts as a proxy for various Docker container registries (Docker Hub, Quay, GCR, etc.). It was converted from an original Cloudflare Worker implementation.

It allows you to use a custom domain to access different registries, potentially bypassing network restrictions or adding a layer of control.

---

## Features

*   Proxies requests to multiple container registries.
*   Handles Docker Registry API v2 authentication flow (token fetching).
*   Supports Docker Hub library image name resolution (e.g., `busybox` -> `library/busybox`).
*   Configurable via environment variables (`.env` files).
*   Separate configurations for development and production environments.

---

## Setup

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd <repository-directory>
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure environments:**
    *   Copy `.env.example` to `.env.production`:
        ```bash
        cp .env.example .env.production
        ```
    *   Edit `.env.production` and set your `CUSTOM_DOMAIN`. This is the domain your proxy will run on (e.g., `docker.mycompany.com`).
    *   (Optional) Edit `.env.development` if you need to change development settings (like `PORT` or `TARGET_UPSTREAM` for debug mode).

---

## Usage

*   **Run in Production Mode:**
    *   Loads configuration from `.env.production`.
    *   Listens on the `PORT` specified in `.env.production` (default: 3000).
    ```bash
    npm start
    ```
    or
    ```bash
    npm run start:prod
    ```

*   **Run in Development Mode:**
    *   Loads configuration from `.env.development`.
    *   Listens on the `PORT` specified in `.env.development` (default: 3001).
    *   Enables `debug` mode by default, which might use `TARGET_UPSTREAM`.
    ```bash
    npm run start:dev
    ```

---

## How it Works

The Node.js server listens for incoming HTTP requests. Based on the request's hostname (e.g., `docker.your-custom-domain.com`), it looks up the corresponding upstream registry URL in its configuration.

It then forwards the request to the upstream registry, handling authentication (`/v2/auth`) and potential redirects (like Docker Hub library images or blob storage locations) as needed.