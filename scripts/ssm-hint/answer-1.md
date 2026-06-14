## 質問

```
AWS環境に AuroraServerless v2 for PostgreSQL、EC2(踏み台サーバー)があるとする。ssmでセッションをローカルPCからDB操作ができるようにしたい。
セッション確率し、中断時には適切に環境をきれいにするためのスクリプトをzx書いて。実務向けでお願い。
```

---

zxスクリプトを書く前に、フロントエンド設計スキルは不要ですが、実務向けの構成を確認します。実務向けのzxスクリプトを作成します。

## スクリプトの概要

### ファイル構成
| ファイル | 役割 |
|---|---|
| `db-tunnel.mjs` | トンネル本体 (zx スクリプト) |
| `.env.tunnel.example` | 環境変数テンプレート |

---

### セットアップ手順

```bash
# 1. zx のインストール (未導入の場合)
npm install -g zx

# 2. Session Manager Plugin のインストール (macOS)
brew install --cask session-manager-plugin

# 3. 環境変数ファイルの準備
cp .env.tunnel.example .env.tunnel
vi .env.tunnel   # 値を埋める

# 4. 実行権限の付与
chmod +x db-tunnel.mjs

# 5. 起動 (環境変数ファイルを読み込んで実行)
set -a && source .env.tunnel && set +a
./db-tunnel.mjs

# またはCLIオプションで直接指定
./db-tunnel.mjs \
  --profile my-profile \
  --instance i-0123456789abcdef0 \
  --host your-cluster.cluster-xxx.rds.amazonaws.com
```

### psql / GUI クライアントで接続

```bash
# psql
psql -h 127.0.0.1 -p 15432 -U dbuser -d mydb

# TablePlus / DBeaver などは下記で接続
# Host: 127.0.0.1  Port: 15432
```

---

### スクリプトが実装していること

| 処理 | 内容 |
|---|---|
| **事前チェック** | `aws` / `session-manager-plugin` の存在確認、AWS認証確認、EC2 の running 状態確認、ローカルポート競合確認 |
| **多重起動防止** | `~/.db-tunnel.pid` で既存プロセスを検出。古い PID なら自動削除 |
| **SSM 確立** | `AWS-StartPortForwardingSessionToRemoteHost` ドキュメントで EC2 経由 Aurora へ中継 |
| **クリーンアップ** | `SIGINT` (Ctrl+C) / `SIGTERM` / `SIGHUP` を捕捉 → SSMプロセス終了 → `ssm:TerminateSession` API でセッション明示削除 → PID ファイル削除 |
| **予期せぬ終了** | SSMプロセスがクラッシュした場合も同じクリーンアップフローを実行 |

### IAM ポリシーの最小権限 (踏み台用ロールに必要なもの)

```json
{
  "Effect": "Allow",
  "Action": [
    "ssm:StartSession",
    "ssm:TerminateSession",
    "ssm:DescribeSessions",
    "ssmmessages:CreateControlChannel",
    "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel",
    "ssmmessages:OpenDataChannel"
  ],
  "Resource": "*"
}
```