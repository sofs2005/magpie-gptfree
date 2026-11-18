# 在没有 Python 的 magpie Docker 里用 GPTFree

`ghcr.io/yetone/magpie` 的镜像是一个静态编译的 Go 二进制（外加 curl），里面
**没有 python、node、npm、uv**——插件是跑在 magpie 自己下载的 Bun 上的。原来的
GPTFree 要求 `python3` + `curl_cffi`，所以在 Docker 版里一装就卡在「未找到可用
Python 3」。

现在插件会自己把运行环境准备好，容器里什么都不用装。

## 它做了什么

首次需要 Python 时（登录、查额度、画图、网页对话），按下面的顺序找解释器：

1. `MAGPIE_GPTFREE_PYTHON` 指定的解释器（如果设了）；
2. 系统 `python3` / `python`（桌面版就是这条，行为和以前完全一样）；
3. 都没有（Docker 版）→ **自己下载一个 uv 二进制，用 uv 装 CPython 3.12，再在
   独立 venv 里装 `curl_cffi`**。

下载与 venv 全部落在 `MAGPIE_GPTFREE_HOME`（默认 `~/.magpie-gptfree`）：

| 路径 | 内容 |
| --- | --- |
| `bin/uv` | uv 二进制（约 17 MB） |
| `python-runtime/` | uv 管理的 CPython 3.12（约 110 MB） |
| `python-venv/` | 装好 `curl_cffi` 的 venv（约 42 MB） |
| `python-cache/` | uv 缓存 |

Docker 版里 `HOME=/config/home`，所以这些都在 `/config` 卷上：**容器重启、换新镜像
都还在**，只有第一次要下载。实测全新环境约 30 秒（uv 17 MB + CPython 33 MB +
curl_cffi 13 MB），之后每次启动 0.2 秒。

系统里的东西一概不动：不装 apt 包、不写 `/usr`、不改全局 pip 配置。TLS 指纹仍是
`curl_cffi` 的 `impersonate=chrome110`，和桌面版走的是同一条请求路径。

## 怎么用

装插件、导入账号，和桌面版一样。第一次点「导入并授权入池」时会多等十几秒（在下载
Python），日志里能看到进度。

想确认环境是否就绪：

```bash
docker exec magpie ls /config/home/.magpie-gptfree/python-venv/bin/python
docker exec magpie /config/home/.magpie-gptfree/python-venv/bin/python -c "import curl_cffi; print(curl_cffi.__version__)"
```

## 网络不通 GitHub / PyPI 时

用环境变量换源（写在 `docker run -e` 或 compose 的 `environment` 里）：

| 变量 | 作用 | 例子 |
| --- | --- | --- |
| `MAGPIE_GPTFREE_UV_MIRROR` | uv 二进制的下载地址前缀 | `https://ghproxy.example/https://github.com/astral-sh/uv/releases/latest/download` |
| `MAGPIE_GPTFREE_PYTHON_MIRROR` | uv 下载 CPython 的地址 | 见 uv 文档 `UV_PYTHON_INSTALL_MIRROR` |
| `MAGPIE_GPTFREE_PIP_INDEX` | 装 `curl_cffi` 的索引 | `https://pypi.tuna.tsinghua.edu.cn/simple` |
| `MAGPIE_GPTFREE_UV` | 已经有一个 uv 二进制时直接指过去 | `/config/home/.local/bin/uv` |
| `MAGPIE_GPTFREE_PYTHON` | 已经有 Python 3 时直接指过去 | `/usr/bin/python3` |

## 想彻底不要 Python？

那就得把 `python/auth_worker.py`、`python/web_text_worker.py`、
`python/image_worker.py` 和 `python/utils/*` 全部用 JS 重写（约 3200 行 Python），
其中 `curl_cffi` 的浏览器 TLS 指纹没有等价的 Node/Bun 实现——`undici` 只能改
ciphers/curves，扩展顺序仍是 Node 的，Cloudflare 那边过不过得去要撞运气。自举
Python 是保真的做法，也是这里采用的做法。
