# 小艺Work 灰度网关 v2.0

独立 Node.js 服务，带**中文 Web 管理面板**，不修改上游 magpie/OpenCode 插件。
参考 [workbuddy-gateway](https://github.com/lijieyu233/workbuddy-gateway) 的卡片网格、
深/浅主题、账号池与请求记录形态重新实现；认证与转发对象仍是小艺Work，不包含
WorkBuddy 的渠道净化、签到或 WorkBuddy 账号导入逻辑。Node.js **22+**，零 npm 运行依赖。

![灰度控制台](artifacts/panel-overview.png)

## 一键启动

### Windows

1. 复制 `config/config.example.json` 为 `config/config.json`，填写你自己的凭据和密钥。
2. 双击 **`start.bat`**，服务启动后自动打开面板。
3. `start-lan.bat` 为局域网模式。管理接口默认仍只允许本机访问。

### Linux / macOS / 命令行

```bash
cp config/config.example.json config/config.json
# 修改 config.json 的两个访问密钥、灰度 salt、上游凭据
chmod 600 config/config.json
npm start -- --open
```

也可直接执行 `./start.sh`。其它启动参数：

```bash
node src/cli.mjs --local --open        # 默认：仅本机 127.0.0.1
node src/cli.mjs --lan --open          # 局域网 API
node src/cli.mjs --port 6000 --open    # 指定端口
node src/cli.mjs --help
```

- 面板：`http://127.0.0.1:17356`
- API：`http://127.0.0.1:17356/v1`
- 首次进入面板输入配置文件里的 `adminKey`。
- 本程序不替代当前已打开的其它 Web 应用；启动后需自行打开上面显示的面板地址。
- 自定义配置位置：`XIAOYI_PROXY_CONFIG=/绝对路径/config.json` 或 `--config 路径`。

## 面板功能

| 页面 | 已实现功能 |
|---|---|
| 灰度控制台 | 启用/停用、0–100% 滑块、1/5/10/25/100% 快捷档、一键回滚、稳定/灰度请求分布 |
| 账号池 | 稳定/灰度分栏、添加、删除、自动续期状态、请求数、手动查询会员积分与权益包 |
| 模型 | 模型卡片、ID 复制、倍率/视觉能力、灰度模型启停确认 |
| 请求记录 | 路由池、账号、结果、耗时、Token；清空日志 |
| 设置 | API/Admin 密钥轮换、超时、Header/Cookie 灰度开关、客户端配置复制 |
| 通用 | 深色/浅色主题、移动端布局、管理密钥仅保存于 sessionStorage |

白名单、黑名单、分桶 salt 等高级灰度字段仍通过 `/_admin/gray` 或配置文件维护。

从原项目 magpie 的 `plugin-auth.json` 中复制**你自己账号**的 `businessCredential`、
`uid`、`deviceId` 和 `refreshToken`。建议 stable/gray 使用独立账号：原项目指出
签新票会让同账号旧票失效，本服务不会回写小艺Work 的 Windows 注册表。

`config/config.json` 被 `.gitignore` 排除，建议权限 `0600`。默认仅监听
`127.0.0.1`。如果改用 `--lan`，API 会监听局域网；面板接口仍按真实来源 IP 限制本机，
不采信 `X-Forwarded-For`。只有确有需要才在配置中设置 `allowPanelFromLan: true`，
并同时配置 HTTPS 与网络访问控制，不应直接暴露公网。

### Docker

```bash
docker compose up -d --build
curl http://127.0.0.1:17356/healthz
```

Compose 默认只映射 `127.0.0.1:17356`。配置目录挂载可写，用于原子保存灰度设置、
续期凭据与请求元数据。

## 灰度语义

- **默认 10%**：以 `x-gray-key`（推荐传稳定用户 ID）为分桶键；没有该头才回退到
  Bearer token 的哈希。不会使用来源 IP，避免 NAT 后所有用户同时进入灰度。
- **稳定分桶**：`SHA256(salt + ":" + identity)` 前 32 bit 映射到 `[0,10000)`；
  `bucket < percentage * 100` 进入灰度。相同 salt 和身份始终同桶，调整百分比不会全局洗牌。
- **优先级**：禁用灰度 → denylist → allowlist → `x-gray-force: 0|1` →
  `x-gray-enabled: true|false` → Cookie `xiaoyi_gray=0|1` → 百分比。
- **默认禁用灰度模型**：`Kimi_K3.1_Pro_VE` 返回 403 `gray_model_disabled`；
  显式设置 `allowGrayModels: true` 后才开放，并路由至灰度池。不是单纯修改显示名称。
- **请求不重写模型名**：`gray.models` 是灰度模型清单，不是把请求替换成其他模型。
- **双账号池**：各池轮询；上游 401/403 且配置 refreshToken 时，自动“代刷 + 立即签票”
  并重试一次。凭据原子写回配置文件。日志只记录账号 id，不记录密钥。
- **SSE 归一化**：强制上游 `stream: true`、补 OpenAI chunk 字段、去 `id:`、补一个
  `data: [DONE]`；客户端 `stream: false` 时聚合成标准 `chat.completion`。
- **观测**：响应带 `x-xiaoyi-route`、`x-xiaoyi-pool`、`x-xiaoyi-gray-reason`、
  `x-xiaoyi-gray-bucket`、`x-xiaoyi-account`（均为内部账号标签，不含凭据）。
- `gray.shadow` 当前保留为配置字段，**未实现镜像双发**，不会影响主请求。

### 配置示例

```jsonc
{
  "apiKey": "至少16字符的客户端访问密钥",
  "adminKey": "不同的至少16字符管理密钥",
  "allowGrayModels": false,
  "gray": {
    "enabled": true,
    "percentage": 10,
    "salt": "部署时生成的固定随机串",
    "pool": "gray",
    "allowHeaderOverride": true,
    "allowCookieOverride": true,
    "allowlist": ["internal-tester"],
    "denylist": [],
    "models": ["Kimi_K3.1_Pro_VE"]
  }
}
```

## 请求

```bash
export BASE=http://127.0.0.1:17356
export KEY=你的_apiKey

curl -N "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -H 'x-gray-key: user-10001' \
  -H 'x-gray-force: 1' \
  -d '{"model":"LLM_DeepSeekV4_Think","stream":true,"messages":[{"role":"user","content":"只回复：可用"}]}'
```

```bash
# 非流式（上游仍是 SSE，由反代聚合）
curl "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -H 'x-gray-key: user-10001' \
  -d '{"model":"LLM_DeepSeekV4_Think","stream":false,"messages":[{"role":"user","content":"你好"}]}'

# 查看模型、状态与灰度命中
curl "$BASE/v1/models" -H "Authorization: Bearer $KEY"
curl "$BASE/_admin/stats" -H 'x-admin-key: 你的_adminKey'

# 热更新灰度至 25%，先原子持久化再切换运行配置
curl -X POST "$BASE/_admin/gray" \
  -H 'x-admin-key: 你的_adminKey' -H 'Content-Type: application/json' \
  -d '{"percentage":25,"allowlist":["internal-tester"]}'
```

OpenAI SDK：

```python
from openai import OpenAI
client = OpenAI(api_key="你的_apiKey", base_url="http://127.0.0.1:17356/v1")
answer = client.chat.completions.create(
    model="LLM_DeepSeekV4_Think",
    messages=[{"role": "user", "content": "你好"}],
    extra_headers={"x-gray-key": "user-10001"},
)
print(answer.choices[0].message.content)
```

## 上线步骤

1. `allowGrayModels=false`、`gray.percentage=0` 启动；用 `x-gray-force: 0/1` 分别验证两池。
2. 确认返回 Header、SSE `[DONE]`、非流式聚合与工具调用。
3. 内测名单写入 `allowlist`，保留 `denylist` 作为紧急退出名单。
4. 逐步调百分比 `1 → 5 → 10 → 25 → 50 → 100`，每档查看 `/_admin/stats` 与上游错误。
5. 回滚时 `percentage=0`，或 `enabled=false`；必要时将指定 `x-gray-key` 加入 `denylist`。
6. 若要开放 Kimi 灰度模型，编辑配置把 `allowGrayModels` 改为 `true` 后重启，
   或通过 `POST /_admin/gray` 传 `{"allowGrayModels":true}` 热更新；
   小流量验证成功前不建议开放，原项目标注其消耗倍率为 `13x`。

## 接口

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/` | 本机 + Admin key | Web 管理面板 |
| GET | `/healthz` | 无 | 存活检查，不含账号信息 |
| GET | `/v1/models` | API key | 模型清单，默认不含灰度模型 |
| POST | `/v1/chat/completions` | API key | 流式/非流式聊天反代 |
| GET | `/api/state` | 本机 + Admin key | 面板聚合状态 |
| GET/POST | `/api/keys` | 本机 + Admin key | 查看/轮换访问密钥 |
| POST/DELETE | `/api/accounts`、`/api/accounts/:id` | 本机 + Admin key | 添加/删除账号 |
| POST | `/api/accounts/:id/quota` | 本机 + Admin key | 查询积分与权益包 |
| GET | `/api/logs` | 本机 + Admin key | 请求元数据日志 |
| POST | `/api/logs/clear` | 本机 + Admin key | 清空请求记录 |
| GET | `/_admin/config` | Admin key | 脱敏运行配置和统计 |
| GET | `/_admin/stats` | Admin key | 按池、原因、账号计数 |
| POST | `/_admin/gray` | Admin key | 原子热更新灰度配置 |

## 原项目分析与复用边界

分析版本：`23991d04e95da075cabf9363184d4c42dd37cd92`（2026-11-23 读取）。

原项目是 **magpie/OpenCode 供应商插件**，自身不是独立 HTTP 反代。其关键链路：

1. `makeFetch` 强制 `/celia/v1/sse-api/chat/completions` 使用 SSE；删除客户端 Bearer，
   注入 `businessCredential + x-uid + x-device-id`。
2. 上游只发 SSE、没有 `[DONE]`；`transformSse` 补 OpenAI 字段与结束标记，
   `aggregate` 负责非流式。
3. 凭据续期必须先 `/user-credential/v1/xiaoyiwork/refresh-token`，随后立刻
   `/business-credential/create`；中间 accessToken 不能缓存。
4. 模型目录依赖 `x-prd-pkg-name: com.huawei.hmos.vassistant`。
5. 原项目的 `showGray` 是“是否显示官方标灰模型”，不是“流量灰度发布”；本服务
   将两者拆开：模型灰度默认拒绝，流量灰度按稳定分桶选择账号池。

原项目声明 MIT，详见 `UPSTREAM_NOTICE.md` 与其
[仓库](https://github.com/llf223/opencode-xiaoyiwork-auth)。本反代只复用协议行为，
没有复制插件登录、Windows DPAPI、本机注册表和 magpie UI 逻辑；也不处理签票后回写
Windows 注册表，故建议使用独立的灰度账号。

## 验证范围

`npm test` 共 **19 项**，使用本机临时 HTTP 服务器和合成 SSE，不消耗真实账号点数：
稳定分桶、灰度边界、Header/Cookie 优先级、灰度模型拒绝、鉴权、SSE 分包、
`[DONE]`、工具调用聚合、池路由、配置脱敏/热更新、401 续期重试、面板静态资源、
账号增删、积分查询、密钥保护、日志元数据与远端面板来源限制。

另使用本机 Chromium 150 对合成账号实例做过浏览器验收：登录、25% 灰度热更新、
账号/模型卡片、添加账号弹窗、深浅主题、移动端 390px 布局均通过，浏览器无 JS 异常。
截图在 `artifacts/`。这些是合成界面数据，不代表真实小艺额度或模型调用结果。

真实模型、真实积分与 OAuth 需部署者使用自己的账号做上线前验证。

## 参考项目

- 小艺认证协议：[opencode-xiaoyiwork-auth](https://github.com/llf223/opencode-xiaoyiwork-auth)，MIT。
- 面板与启动方式参考：[workbuddy-gateway](https://github.com/lijieyu233/workbuddy-gateway)，分析版本 `f5d26d5d424fa7565403ff3e959822e008ddce30`。
- 本面板为独立重写，不依赖参考项目运行，不加载其外部脚本、字体、图片或接口。
