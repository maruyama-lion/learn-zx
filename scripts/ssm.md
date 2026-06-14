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

## 実行方法

```bash
# CLI オプションで直接指定（pnpm 経由では -- が必要）
pnpm db-tunnel -- \
  --instance i-0123456789abcdef0 \
  --secret   aurora/mydb/credentials

# プロファイル・リージョンを指定する場合
pnpm db-tunnel -- \
  --profile  my-profile \
  --region   ap-northeast-1 \
  --instance i-0123456789abcdef0 \
  --secret   aurora/mydb/credentials

# 環境変数で指定する場合（-- 不要になるので楽）
export BASTION_INSTANCE_ID=i-0123456789abcdef0
export DB_SECRET_ID=aurora/mydb/credentials
pnpm db-tunnel
```

トンネル確立後、別ターミナルから接続する（接続コマンドはスクリプトが起動時に表示する）。

```bash
PGPASSWORD='...' psql -h 127.0.0.1 -p 15432 -U dbadmin -d mydb
```

終了は `Ctrl+C`。

---

## オプション一覧

| オプション | 環境変数 | デフォルト | 説明 |
|---|---|---|---|
| `--instance` | `BASTION_INSTANCE_ID` | (必須) | EC2 踏み台のインスタンス ID |
| `--secret` | `DB_SECRET_ID` | (必須) | Secrets Manager のシークレット名または ARN |
| `--profile` | `AWS_PROFILE` | `default` | AWS CLI プロファイル |
| `--region` | `AWS_REGION` | `ap-northeast-1` | AWS リージョン |
| `--local-port` | `LOCAL_PORT` | `15432` | ローカル側のポート番号 |

---

## 起動フロー

```
起動
├─ 必須パラメータ確認
├─ aws / session-manager-plugin の存在確認
├─ AWS 認証確認 (sts get-caller-identity)
├─ [並列] Secrets Manager からシークレット取得
│         EC2 インスタンスの running 状態確認
├─ ローカルポート競合確認
├─ 多重起動防止 (~/.db-tunnel.pid)
├─ SSM ポートフォワーディング開始
│   └─ [非同期] 自分の SessionId を特定して PID ファイルに記録
│
│  Ctrl+C / kill / ターミナル切断
│
└─ クリーンアップ
    ├─ SSM プロセスに SIGTERM → 3秒後 SIGKILL
    ├─ terminate-session で AWS 側のセッションを明示終了
    └─ ~/.db-tunnel.pid 削除
```

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
rm -f ~/.db-tunnel.pid
```

---

### `ローカルポート 15432 は既に使用中です`

前回のトンネルが正常に終了しなかった場合など。

```bash
# ポートを使っているプロセスを確認
lsof -i :15432

# PID を確認して kill
kill <PID>

# PID ファイルも残っていれば削除
rm -f ~/.db-tunnel.pid
```

別ポートで起動したい場合は `--local-port 25432` のように指定する。

---

### `既にトンネルが起動しています`

```bash
# 既存のトンネルを終了する
kill <表示された PID>

# プロセスが既に死んでいるのにエラーになる場合は PID ファイルを削除
rm -f ~/.db-tunnel.pid
```

---

### `AWS 認証に失敗しました`

```bash
# プロファイルの認証情報を更新する
aws configure --profile <PROFILE>

# SSO を使っている場合
aws sso login --profile <PROFILE>
```

---

### `EC2 インスタンスが running 状態ではありません`

踏み台 EC2 が停止している。AWS コンソールまたは CLI で起動する。

```bash
aws ec2 start-instances --instance-ids <BASTION_INSTANCE_ID>
# インスタンスが running になるまで待つ
aws ec2 wait instance-running --instance-ids <BASTION_INSTANCE_ID>
```
