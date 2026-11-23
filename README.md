# 小艺Work OpenAI 兼容灰度反代

独立 Node.js 服务，不修改上游 magpie/OpenCode 插件。客户端使用
`POST /v1/chat/completions`，反代把凭据换成小艺Work 三件套，按稳定身份灰度分桶，
再转到 `stable` / `gray` 账号池。Node.js **22+**，零 npm 运行依赖。

## 启动

```bash
cd opencode-xiaoyiwork-proxy
cp config/config.example.json config/config.json
# 修改 config.json 的两个访问密钥、上游凭据与灰度 salt
npm test
npm start
```

从原项目 magpie 的 `plugin-auth.json` 中复制你自己账号的
`businessCredential`、`uid`、`deviceId` 和 `refreshToken`，不要从浏览器或他人账号导出。
`gray` 池可填写同一个账号，也可用单独账号做配额隔离；使用独立灰度账号时，
不要主动刷新共享同一账号的另一槽位——原项目已指出签新票会使旧票失效。

`config/config.json` 不会进入版本控制。生产环境建议通过受控部署生成，权限设为 `600`。
监听地址默认 `0.0.0.0`；公网部署务必在前面放 HTTPS 终止层，且限制 `/_admin/*` 的访问来源。
若工作目录不在项目根目录，设置 `XIAOYI_PROXY_CONFIG=/绝对路径/config/config.json`。

Docker 部署（`config/config.json` 已填写后）：

```bash
docker compose up -d --build
curl http://127.0.0.1:17356/healthz
```

Compose 默认只绑定 `127.0.0.1:17356`，配置目录可写用于原子保存续期凭据与热更新。

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
| GET | `/healthz` | 无 | 存活检查，不含账号信息 |
| GET | `/v1/models` | API key | 模型清单，默认不含灰度模型 |
| POST | `/v1/chat/completions` | API key | 流式/非流式聊天反代 |
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

`npm test` 使用本机临时 HTTP 服务器和合成 SSE，不消耗真实账号点数：
稳定分桶、灰度边界、Header/Cookie 优先级、灰度模型拒绝、鉴权、SSE 分包、
`[DONE]`、工具调用聚合、池路由、配置脱敏/热更新、401 续期重试。

真实模型、真实积分与 OAuth 需部署者使用自己的账号做上线前验证。
