# Docker Registry 代理 (Node.js 版本)

本项目提供了一个 Node.js 应用程序，作为各种 Docker 容器镜像仓库（Docker Hub、Quay、GCR 等）的代理。它是由原始的 Cloudflare Worker 实现转换而来。

它允许你使用自定义域名访问不同的镜像仓库，可能用于绕过网络限制或增加一层控制。

---

## 功能

*   代理到多个容器镜像仓库的请求。
*   处理 Docker Registry API v2 认证流程（获取令牌）。
*   支持 Docker Hub 官方镜像名称解析（例如 `busybox` -> `library/busybox`）。
*   可通过环境变量（`.env` 文件）进行配置。
*   为开发和生产环境提供独立的配置。

---

## 安装设置

1.  **克隆仓库：**
    ```bash
    git clone <your-repo-url>
    cd <repository-directory>
    ```

2.  **安装依赖：**
    ```bash
    npm install
    ```

3.  **配置环境：**
    *   复制 `.env.example` 到 `.env.production`：
        ```bash
        cp .env.example .env.production
        ```
    *   编辑 `.env.production` 并设置你的 `CUSTOM_DOMAIN`。这是你的代理将运行的域名（例如 `docker.mycompany.com`）。
    *   （可选）编辑 `.env.development` 如果你需要更改开发设置（例如 `PORT` 或调试模式下的 `TARGET_UPSTREAM`）。

---

## 使用方法

*   **运行生产模式：**
    *   从 `.env.production` 加载配置。
    *   监听 `.env.production` 中指定的 `PORT`（默认为 3000）。
    ```bash
    npm start
    ```
    或
    ```bash
    npm run start:prod
    ```

*   **运行开发模式：**
    *   从 `.env.development` 加载配置。
    *   监听 `.env.development` 中指定的 `PORT`（默认为 3001）。
    *   默认启用 `debug` 模式，可能会使用 `TARGET_UPSTREAM`。
    ```bash
    npm run start:dev
    ```

---

## 工作原理

Node.js 服务器监听传入的 HTTP 请求。根据请求的主机名（例如 `docker.your-custom-domain.com`），它在配置中查找对应的上游镜像仓库 URL。

然后，它将请求转发到上游镜像仓库，并根据需要处理认证（`/v2/auth`）和潜在的重定向（例如 Docker Hub 官方镜像或 blob 存储位置）。