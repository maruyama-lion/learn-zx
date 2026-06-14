## 質問

```
Auroraが暗号化され、SercretManagerに色々情報が載っている
```

---

その前提が加わると、スクリプトに **Secret Manager からの認証情報取得** を組み込むのが実務的です。まず構成を整理します。

---

### AWS側で期待される構成

**Secrets Manager のシークレット構造**

```json
{
  "username": "dbadmin",
  "password": "xxxxxxxx",
  "host": "your-cluster.cluster-xxx.ap-northeast-1.rds.amazonaws.com",
  "port": 5432,
  "dbname": "mydb",
  "engine": "postgres"
}
```

Aurora + Secrets Manager の自動ローテーションを有効にしていると、RDSがこの形式で管理してくれます。`host` も入っているので `.env.tunnel` の `DB_HOST` も不要になります。

**必要な追加 IAM 権限（ローカルPC側ユーザー）**

```json
{
  "Effect": "Allow",
  "Action": [
    "secretsmanager:GetSecretValue",
    "kms:Decrypt"
  ],
  "Resource": [
    "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:your-secret-name-*",
    "arn:aws:kms:ap-northeast-1:123456789012:key/your-kms-key-id"
  ]
}
```

`kms:Decrypt` はシークレットがカスタマー管理KMSキーで暗号化されている場合に必要です。

---

ではスクリプトを更新します。### 変更点のまとめ

**`--host` / `DB_HOST` を廃止** — Secrets Manager の `host` フィールドから自動取得するため不要になりました。`.env.tunnel` もシンプルになっています。

---

### Secrets Manager で期待するシークレット構造

```json
{
  "host":     "your-cluster.cluster-xxx.ap-northeast-1.rds.amazonaws.com",
  "port":     5432,
  "username": "dbadmin",
  "password": "xxxxxxxx",
  "dbname":   "mydb",
  "engine":   "postgres"
}
```

Aurora の「認証情報を Secrets Manager で管理」を有効にするとこの形式で自動生成されます。`engine` は本スクリプトでは使っていませんが、RDS が付与するフィールドなのでそのまま残して問題ありません。

---

### 起動フロー

```
./db-tunnel.mjs
  │
  ├─ checkDependencies()   aws / session-manager-plugin の存在確認
  ├─ checkAwsAuth()        sts get-caller-identity で認証確認
  ├─ fetchSecret()  ─┐     SecretString を取得・JSON パース・必須キー検証
  ├─ checkInstance() ┘     (2つは並列実行)
  ├─ isPortInUse()         ローカルポート競合確認
  ├─ writePidFile()        多重起動防止
  │
  ├─ 接続情報を表示 (パスワードはマスク表示 / psql コマンドは平文で表示)
  │
  └─ aws ssm start-session (AWS-StartPortForwardingSessionToRemoteHost)
        │
        Ctrl+C / SIGTERM / SIGHUP
        │
        └─ cleanup()
              ├─ SIGTERM → SIGKILL (3秒タイムアウト)
              ├─ ssm terminate-session (残存セッションを並列終了)
              └─ PID ファイル削除
```

---

### IAM 追加が必要な権限（前回からの差分）

```json
{
  "Effect": "Allow",
  "Action": [
    "secretsmanager:GetSecretValue",
    "kms:Decrypt"
  ],
  "Resource": [
    "arn:aws:secretsmanager:ap-northeast-1:ACCOUNT_ID:secret:your-secret-name-*",
    "arn:aws:kms:ap-northeast-1:ACCOUNT_ID:key/YOUR_KMS_KEY_ID"
  ]
}
```

`kms:Decrypt` はシークレットがカスタマー管理KMSキー（CMK）で暗号化されている場合のみ必要です。デフォルトの AWS マネージドキー（`aws/secretsmanager`）の場合は不要です。