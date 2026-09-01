# Resource-Aware Routing Policy

Quota 是 routing signal，不是 architecture authority。

## Never Guess
讀不到可靠 usage 時：`state = UNKNOWN`。禁止估算。

## Track Separately
- short rolling window (例如 5h)
- weekly window
- reset ETA/timestamp
- provider availability

## State
GREEN 正常；YELLOW 分流低風險 context-heavy/review；RED 保留 provider 給明顯有優勢的工作；UNKNOWN 只依 capability routing。

## Cache
<5min reuse；stale refresh；critical routing 可 force refresh。

## OpenUsage
OpenUsage 作 provider quota aggregation 的 reference implementation，不是 Windows workflow 前置條件。native app 目前要求 macOS 15+。
