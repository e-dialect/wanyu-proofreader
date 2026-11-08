# 账户安全与本机草稿

本实现复用 PocketBase 0.40.6 的认证和 tokenKey，不引入会话表或设备清单。接入时在 `registerTrustedClientIP(app)` 后调用 `registerAccountSecurity(app)`，另调用 `registerAccountRecoveryCommand(app)` 注册维护命令。数据库先执行 1794201000、1794201100、1794201200 三个迁移，再发布新后端和前端。

## 接口与兼容

| 接口 | 输入 | 成功与限制 |
| --- | --- | --- |
| `PATCH /api/fangji/profile` | `{name}` | 原有 `{record,token}`；token 为提交时的原 token。旧客户端发送与现值相同的 email 可忽略，变更 email 整体拒绝，不部分保存昵称 |
| `GET /api/fangji/auth/capabilities` | 无 | `{emailActionsEnabled}`；`no-store` |
| `POST /api/fangji/auth/logout-all` | `{}`，users 登录 | 204，无新 token；同事务刷新 tokenKey 和写成功审计；旧 token 重试 401（作用幂等，不提供撤销收据） |
| `PATCH /api/collections/users/records/{id}` | `{oldPassword,password,passwordConfirm}` | PB 原生改密校验，成功200；改密自动轮换 tokenKey，审计失败回滚 |
| `POST /api/collections/users/request-password-reset` | `{email}` | 204 表示已受理，不证明地址存在或投递成功 |
| `POST /api/collections/users/confirm-password-reset` | `{token,password,passwordConfirm}` | 204；同事务重验 token、解除初始密码标志、保存、审计 |
| `POST /api/collections/users/request-email-change` | `{newEmail}`，登录 | 204；初始密码账号须先改密 |
| `POST /api/collections/users/confirm-email-change` | `{token,password}` | 204；需要当前密码，原生设置 verified 并轮换 tokenKey，同事务审计 |
| `POST /api/collections/users/request-verification` | `{email}` | 204，不确认地址存在 |
| `POST /api/collections/users/confirm-verification` | `{token}` | 204；首次验证与审计同事务；重复确认不重复记成功事件 |

昵称接口不再授予表单超级用户权限。原生 users 集合 `manageRule` 仍为 null；普通用户与业务 platform_admin 不能利用原生更新直接替换邮箱或 verified。平台角色与初始密码标志的现有 JS 权限 hook 保留。

退出所有设备对**后续认证与新会话签发**生效，不承诺撤销已经执行的业务事务。profile 在事务内比较请求认证快照的 tokenKey；refresh 只可签发相同代际；绑定外部资料的网络访问在事务外预取，事务内比较原代际，然后绑定、应用缓存、签发 token、记审计。任何路径都不能在撤销后将旧认证请求升级到新代际。新密码登录和外部凭据重新认证属于新的登录。撤销同时使旧代际的私有文件 token 无效，并清除关联 realtime 连接的认证状态；连接可继续作为匿名连接存在。应用组合测试经真实 `/api/realtime` 绑定客户端，覆盖四种撤销操作及审计失败回滚，不以订阅端点是否204推断仍然登录。

前端更新/绑定继续使用现有 `withCurrentSession`，防止延迟响应覆盖另一标签页的新账号。logout-all 网络结果不明时仅确认“本机已退出”，提示重新登录后重试，不宣称其他设备已退出。

## 邮件发布前置条件

仅当后端 `ACCOUNT_EMAIL_ACTIONS_ENABLED=true`、PB SMTP enabled、`Meta.AppURL` 为 HTTPS 时开放邮件申请。默认关闭；没有 SMTP 时恢复页明确指向管理员，邮件申请对已注册和未知地址均503。令牌确认不受新申请开关影响，已经发出的有效链接仍可使用。邮件发送在 PocketBase 异步投递中发生，不能和账户变更组成同一事务；204 不是投递凭据，成功审计只记录实际确认后的账户变更。

模板迁移只替换默认旧路径，不覆盖其他自定义正文，不改变有效期：密码重置和邮箱变更 30 分钟，邮箱验证 7 天。自定义模板若已改成其他链接，需要运营人员预览并手工确认。默认关闭管理台的 nginx 在 `/_` 与 `/_/` 仅提供静态桥接，其他 `/_/…` 仍404；桥接不代理管理台。fragment 只在浏览器解析，先移除再跳至 `/account/reset-password`、`/account/confirm-email`、`/account/verify-email`。账户页面在 API 调用前再次移除 fragment，仅内存保留 token。

**桥接至少保留到模板正式切换 7 天后**；如果旧模板仍在使用，应延长。RUM、错误采集和代理日志不得记录账户页 query/hash、密码或 token。上线前用独立测试邮箱验证真实收信、投递延迟、过期/重复链接与旧链接；本地测试不证明 SMTP 已配置。

## 审计与保留

`security_events` 是只追加专用集合，原生 create/update/delete 请求即使 PB superuser 也拒绝；服务端模型保存可写。字段：`event_type`、`outcome(success/denied/failed)`、`source(web/system/cli)`、文本 `actor_id/subject_user_id/project_id/resource_type/resource_id/request_id/reason_code`、`details` JSON（8192字节上限）、`created`。文本ID避免用户/项目删除级联抹去历史。details 只接受白名单标量，不接请求体、姓名、邮箱、密码、token、外部 subject 或校对内容。

成功审计覆盖：改密/首次改密/重置、邮箱确认/验证、外部绑定、全设备退出、CLI恢复、原生平台角色变更、成员角色/移除、所有者变更、创建授权、访问模式/口令变更、批量志愿者创建、项目删除。成功事件和对应变更在同一数据库事务中，写审计失败则变更回滚。**不回填启用前的历史。**

Go 账户失败、JS 权限操作失败和登录失败共用一个单实例内存预算。事务失败在事务返回/回滚后另写：每可信来源与事件类型每分钟只保留首条，每来源跨类型最多3条，这些入口合计最多10次数据库写入尝试/分钟。窗口按 UTC 分钟划分，边界附近可在短时间内使用前后两个窗口的预算。失败持久化仍消耗预算，不能借数据库故障无限重试；持久化失败只写固定事件名/request_id 告警，不替换业务错误。成功事件不经过该预算，仍与变更强绑定。其他工作包的流失败须在其失败边界接入同一门禁才能共享此预算；不承诺整张表的所有 failed 或授权/开始等成功事件都有该数量上限。

来源由可信代理中间件提供，回退只用直连 IP，忽略源端口和未经信任的 XFF；来源仅以每进程随机盐的 HMAC 指纹保留在内存，来源/IP/指纹不写入事件或日志。每窗口最多保留10组来源指纹，事件类型计数使用固定词表。重复与超预算失败只增加计数，每分钟至多一条 `security_failure_aggregate` 结构化汇总，包含 observed、write_attempts、duplicate/source/global_suppressed 和固定类型的 event_counts；静默后的末个窗口由每分钟任务输出。重启会丢失未输出的内存计数并重置预算，因此这属于首条抽样与聚合，**不是逐请求取证或可靠投递日志**。共享出口的其他账号可能只计入聚合；预算耗尽后的新来源也可能没有单独事件。原生表单进入 hook 前的拒绝、无身份畸形请求、限流早拒绝不保证进入该聚合；结合请求错误率观察趋势。邮件排队/投递不计为成功改密。

`GET /api/fangji/security-events?scope=mine|project|platform&page=1&perPage=25`：最多100条，稳定 `created,id` 倒序。mine 查询 subject_user_id 为本人的账户及权限相关记录，包含 success/denied/failed，且只返回 id/时间/事件名/结果/projectId；仅作为操作者但主体是他人的记录、主体未确认的匿名登录失败不属于 mine；project 必须当前项目所有者、manager 或平台管理员，只查询 project_id 对应事件；platform 仅业务 platform_admin。管理视图增加 actor/subject/requestId/details。UI 显示本人最近25条；管理审计可通过此 API 获取。索引覆盖创建时间、主体、操作者、项目。

每分钟按 failed、denied、success 分别执行一个最多500条的删除批次（各自提交），删除超过30天的失败/拒绝和超过365天的成功事件；`(outcome,created,id)` 索引支持分类型清理。失败清理容量500条/分钟覆盖自身10次/分钟写入预算，成功历史积压不会抢占失败清理批次。稳定运行时，经过共享门禁的失败写入最多600条/小时、30天432,000条，另有当前窗口和清理延迟；成功事件不受该数量预算限制。小实例采用单进程任务；停机期间不会清理，恢复后逐批追赶，磁盘/任务故障需要监控，不能将批次容量当成清理必然成功的承诺。迁移 down 遇已有审计记录拒绝删除集合，需先按既定保留/归档政策处理，不能为回滚直接清空事件。运行版本回滚可保留该新增集合。

## 限流与部署边界

单实例内存固定窗口，最多10,000个活动 key，不淘汰未过期桶来绕过限制。重启会清空，横向扩容前必须换共享存储或网关限流。IP 仅来自 `registerTrustedClientIP` 的可信代理配置，客户端伪造 XFF 不改变身份。

- 登录：本地密码与外部密码登录共用每 IP 120/分钟、全实例600/分钟；每 identity（规范化后散列，登录渠道隔离）10/分钟。原外部登录10次/5分钟 IP 限制在统一中间件生效时不叠加。
- 注册：每 IP 60/分钟。邮件申请：每 IP 60/分钟、每目标邮箱1次/2分钟、10次/小时；恢复/验证频率限制统一204。更换邮箱另限每用户5次/小时，受限响应的 Retry-After 为3600秒；其他显式429返回60秒。
- 确认令牌：每 IP 60/分钟，每令牌指纹10/分钟。退出所有设备每用户5/分钟。
- 认证和邮件申请请求体上限16KiB；令牌不进入限流 key（仅散列）。30个独立账号同出口可正常尝试登录。

不使用低 IP 阈值封锁学校/机构共享出口。错误尝试过多会影响同一账号的短时登录；前端给出重试提示，不新增验证码、MFA或会话基础设施。

## 管理员初始化与恢复

环境变量 APP_ADMIN_* / PB_ADMIN_* 通过永久 `bootstrap_bindings` 绑定到初始账号 ID；邮箱不是重启时重新创建管理员的依据。已绑定 ID 存在时，启动不会修改邮箱、密码、角色、验证状态或初始密码标志，也不会因账号改过邮箱而用旧环境变量再建管理员。日常恢复不修改环境变量，不删除数据卷。新账号仍应按现有引导尽快设置独立密码。

迁移 `1794204500` 仅建立内部集合，不猜测历史身份。首次运行时，环境邮箱与已有账号匹配只建立绑定，不修改账号；邮箱没有匹配而集合非空则拒绝自动创建，记录固定原因 `legacy_identity_unresolved`。只有真正空集合可首次创建。已有绑定时，必须成功查询并确认原 ID 已删除、且原环境邮箱未被其他账号占用，才允许重建并更新绑定；任何查询错误都拒绝继续，邮箱被占用不会接管或提权。

绑定保存集合名、规范化环境邮箱的 SHA-256 和原记录 ID（文本，无外键），无自动清理期限；所有账号与绑定读取、创建和更新均在同一数据库事务内，保存绑定失败会回滚新账号。普通 API 的五项规则均关闭，额外禁止包括超管在内的原生记录创建、修改和删除请求；受信任超管的集合结构维护及直接数据库管理仍属于运维边界，不受记录请求 hook 限制。迁移回滚只允许空集合；已有绑定时拒绝 down，回退应用代码时保留此集合。环境变量遗漏或不完整时不会尝试修复账号；日志仅记录集合与固定原因，不输出邮箱、密码或令牌。

恢复前停止后端容器，暂停自动重启/更新控制器，确认备份可用并记录精确账号ID。包装器仅支持 Docker：实际 inspect 必须得到 exited、PID 0、无 running/restarting/paused，识别其唯一 `/pb/pb_data` 可写挂载，并拒绝其他活动容器复用或覆盖该挂载。无检查能力、非 Docker 运行方式、未知挂载布局、root 容器或旧镜像均拒绝；不接受“已停机”声明参数。底层 `recover-account` 命令仍是维护原语，不独立证明停机，应通过包装器调用。

```sh
python3 scripts/recover_account.py \
  --container wanyu-backend --collection users \
  --id EXISTING_RECORD_ID --operator operator-label
```

包装器用目标容器的不可变本地 image ID，在未挂数据目录时先验证命令存在；密码确认后重新检查容器与所有共享挂载，再启动一次性、无网络、只读根文件系统、无 capabilities 的非 root 恢复容器。固定挂载对应唯一容器名阻止两个包装器同时恢复。检查与启动之间没有 Docker 全局原子锁；运维必须暂停外部自动重启控制器，且不得有 Docker 之外的进程访问数据库。包装器不自动停生产服务，也不删除卷。

Python 使用终端无回显 getpass，密码通过子进程 stdin 传入，不出现在 argv/env/history/输出。底层命令为 `recover-account --password-stdin`，仅接受 users 或 _superusers 的精确已有ID，禁止创建、提权或修改邮箱；恢复普通用户强制首次改密，同事务撤销 tokenKey 并记录 source=cli。CLI 执行禁用 bootstrap，不能顺带创建环境管理员。不得把密码输出、剪贴板或工单内容写入 operator。密码12–71字符、最多72 UTF-8字节。

## 本机草稿

`/account/security` 列出当前账号的当前草稿与历史版本，标示超过30天的数量。不会自动删除唯一未提交副本；可导出 JSON（包含原始草稿/损坏条目，需用户妥善保管），经明确勾选确认后仅清理这个账号的 draft 前缀。确认期间另一标签页新保存的同 key 内容保留。其他账号、登录信息、站点设置、服务端校对记录不受影响。公共设备应在提交/导出后使用此入口清理，并退出登录。

## 验证边界

`run_account_security_integration.py` 运行真实 API 后停止临时后端，以 stdin 离线恢复已有账号，再重启确认 bootstrap 不恢复旧环境密码/角色、不额外创建账号、旧 token 失效。它还通过原生超管管理 API 修改 users 邮箱/验证状态并保留自降权，原生 PATCH 修改 _superusers 邮箱/密码，保留旧环境变量重启后验证原 ID 和永久绑定不变、旧凭据不能复活；此邮箱覆盖不代表实际 SMTP 送达已验收。Go 的 `TestBootstrapBinding*` 验证历史 schema 升级与空集合 up/down/up、非空 down 拒绝、查询故障关闭、邮箱占用拒绝以及绑定保存失败回滚；CI 的 account_security 矩阵明确调用此 runner。Docker 包装器停机/挂载/隔离约束有独立 Python 测试；真实 Docker 恢复演练、实际 SMTP 送达仍需发布前完成；root 已用一次性官方 Nginx 容器验证旧链接桥、CSP、缓存与管理 UI 关闭，超管 API 路由保持独立边界，不能由本地 API 测试替代。账户页使用视图代际与 AbortSignal，切换身份、token、路由或离开页面即清理旧数据并拒绝迟到结果。

集成工作包另已接入交付创建与导出审计：delivery.created 与包记录同事务，审计失败清理新 ZIP 并回滚；export.authorized 在正文前短事务重新校验身份/权限，export.stream_finished 仅表示服务端传输结果。传输结束后的审计持久化失败会告警，不能撤回已经发出的字节，也不能把开始事件或服务器写完当成接收方确认。


最终集成补充：导出流失败也通过同一失败审计门禁并保留project/resource/count快照；成功导出授权、传输结果与交付创建继续按各自边界记录。失败预算与持久化缺口同时写入脱敏JSONL，便于部署采集器发现；PB原始请求activity日志已由模板化HTTP事件替代，旧日志不回填或删除。
