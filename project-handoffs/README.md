# Project Handoffs

專案的 handoff 通常與該專案一起保存，或另行提供；**這個共用的 workflow repository
只放 sanitized 範例或說明**。

使用 `templates/CURRENT_PROJECT_HANDOFF_TEMPLATE.md`。

## 禁止提交至此目錄

- 真實客戶資料或個人資料（姓名、email、電話、地址、身分識別碼）
- credential、token、cookie、API 金鑰、連線字串
- provider 的原始 quota 回應或 conversation ID
- 內部系統主機名稱、內網位址、正式環境識別資料
- 任何未經該專案 owner 同意公開的營運細節

## 允許

- 完全 sanitized 的範例 handoff，用來示範欄位怎麼填
- 不含專案識別資訊的填寫說明

Sanitize 的意思是**移除**，不是遮蔽。把真實值改寫成 `example-repo`、`UNKNOWN` 或
`<redacted>`，不要保留可反推的片段。

這個 repository 預計公開發布，其 Git history 本身即為公開產物：
一旦提交，事後刪除並不會讓它從歷史中消失。提交前先確認，而不是事後補救。
