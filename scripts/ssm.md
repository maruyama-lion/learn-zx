# Aurora SSM トンネル — 使い方

SSM Session Manager 経由で Aurora Serverless v2 (PostgreSQL) へポートフォワーディングするスクリプト。

---

## 前提条件

### ローカルPC

| ツール | 確認コマンド | インストール |
|---|---|---|
| AWS CLI v2 | `aws --version` | [公式](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) |
| Session Manager Plugin | `session-manager-plugin --version` | `brew install --cask session-manager-plugin` |
| Node.js + zx | `zx --version` | `npm install -g zx` |

### AWS 側

- EC2 踏み台に `AmazonSSMManagedInstanceCore` がアタッチされていること
- Aurora がプライベートサブネットにあり、踏み台 SG からの 5432 を許可していること
- Secrets Manager に以下の形式でシークレットが存在すること

```json
{
  "host":     "your-cluster.cluster-xxx.ap-northeast-1.rds.amazonaws.com",
  "port":     5432,
  "username": "dbadmin",
  "password": "xxxxxxxx",
  "dbname":   "mydb"
}
```

### 操作者 IAM の必要権限

```json
{
  "Effect": "Allow",
  "Action": [
    "ssm:StartSession",
    "ssm:TerminateSession",
    "ssm:DescribeSessions",
    "ec2:DescribeInstances",
    "secretsmanager:GetSecretValue",
    "kms:Decrypt"
  ],
  "Resource": "*"
}
```

`kms:Decrypt` はシークレットがカスタマー管理 KMS キーで暗号化されている場合のみ必要。

---

## セットアップ

```bash
cp .db-tunnel.example.json .db-tunnel.json
# .db-tunnel.json を編集して各環境の値を設定する
```

`.db-tunnel.json` はインスタンス ID やシークレット名を含むため `.gitignore` に追加することを推奨。

### 設定ファイルのフォーマット

```json
{
  "dev": {
    "profile":    "dev-profile",
    "region":     "ap-northeast-1",
    "instanceId": "i-0123456789abcdef0",
    "secretId":   "aurora/dev/credentials",
    "localPort":  15432
  },
  "stg": {
    "profile":    "stg-profile",
    "instanceId": "i-abcdef1234567890",
    "secretId":   "aurora/stg/credentials",
    "localPort":  15433
  }
}
```

| フィールド | 必須 | 説明 |
|---|:---:|---|
| `instanceId` | ✅ | EC2 踏み台のインスタンス ID |
| `secretId` | ✅ | Secrets Manager のシークレット名または ARN |
| `profile` | — | AWS CLI プロファイル (デフォルト: `default`) |
| `region` | — | AWS リージョン (デフォルト: `ap-northeast-1`) |
| `localPort` | — | ローカル側ポート番号 (デフォルト: `15432`) |

---

## 実行方法

```bash
pnpm db-tunnel -- --env dev
pnpm db-tunnel -- --env stg
pnpm db-tunnel -- --env prod
```

トンネル確立後、別ターミナルから接続する（接続コマンドはスクリプトが起動時に表示する）。

```bash
PGPASSWORD='...' psql -h 127.0.0.1 -p 15432 -U dbadmin -d mydb
```

終了は `Ctrl+C`。

### 複数環境を同時に接続する

設定ファイルで環境ごとに `localPort` を変えておけば同時起動できる。

```bash
# ターミナル1
pnpm db-tunnel -- --env dev   # → 127.0.0.1:15432

# ターミナル2
pnpm db-tunnel -- --env stg   # → 127.0.0.1:15433
```

### 実行時オーバーライド

`profile` / `region` / `local-port` は CLI フラグで上書きできる。

```bash
# dev 環境の設定を使いつつポートだけ変える
pnpm db-tunnel -- --env dev --local-port 25432
```

---

## オプション一覧

| オプション | デフォルト | 説明 |
|---|---|---|
| `--env` | (必須) | 設定ファイルの環境名 |
| `--profile` | 設定ファイル → `AWS_PROFILE` → `default` | AWS CLI プロファイル |
| `--region` | 設定ファイル → `AWS_REGION` → `ap-northeast-1` | AWS リージョン |
| `--local-port` | 設定ファイル → `15432` | ローカル側のポート番号 |
| `--config` | `.db-tunnel.json` | 設定ファイルのパス (`DB_TUNNEL_CONFIG` でも指定可) |

---

## トラブルシューティング

### `自分の SSM セッションを特定できませんでした`

SessionId の記録に失敗した状態でスクリプトが終了した場合、AWS 側にセッションが残っている可能性がある。以下の手順で手動クリーンアップする。

**1. 自分の IAM ARN を確認する**

```bash
aws sts get-caller-identity --query Arn --output text
# → arn:aws:iam::123456789012:user/your-name
```

**2. 踏み台へのアクティブセッションを一覧表示する**

```bash
aws ssm describe-sessions \
  --state Active \
  --filter key=Target,value=<BASTION_INSTANCE_ID> \
  --query "Sessions[*].{Id:SessionId,Owner:Owner,Start:StartDate}" \
  --output table
```

`Owner` が手順 1 の ARN と一致する行が自分のセッション。

**3. セッションを終了する**

```bash
aws ssm terminate-session --session-id <SESSION_ID>
```

**4. PID ファイルが残っていれば削除する**

```bash
rm -f ~/.db-tunnel-15432.pid   # ポート番号は使用したものに合わせる
```

---

### `ローカルポート 15432 は既に使用中です`

```bash
# ポートを使っているプロセスを確認して kill
lsof -i :15432
kill <PID>

# PID ファイルも残っていれば削除
rm -f ~/.db-tunnel-15432.pid
```

---

### `既にトンネルが起動しています`

```bash
kill <表示された PID>

# プロセスが既に死んでいるのにエラーになる場合
rm -f ~/.db-tunnel-15432.pid
```

---

### `AWS 認証に失敗しました`

```bash
aws configure --profile <PROFILE>

# SSO の場合
aws sso login --profile <PROFILE>
```

---

### `EC2 インスタンスが running 状態ではありません`

```bash
aws ec2 start-instances --instance-ids <BASTION_INSTANCE_ID>
aws ec2 wait instance-running --instance-ids <BASTION_INSTANCE_ID>
```

---

### `環境 "xxx" が設定ファイルに存在しません`

```bash
# 設定ファイルの環境一覧を確認する
cat .db-tunnel.json | jq 'keys'
```
