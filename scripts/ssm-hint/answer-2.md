## 質問

```
大前提として以下はどうなっているべき？

* AWS側の構成
```

---

## AWS側の必要構成

### 1. EC2 踏み台サーバー

**IAM インスタンスプロファイル（ロール）**

```json
{
  "Effect": "Allow",
  "Action": [
    "ssmmessages:CreateControlChannel",
    "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel",
    "ssmmessages:OpenDataChannel",
    "ssm:UpdateInstanceInformation",
    "ssm:ListInstanceAssociations",
    "ssm:DescribeInstanceProperties",
    "ssm:DescribeDocumentParameters"
  ],
  "Resource": "*"
}
```

AWSマネージドポリシーの `AmazonSSMManagedInstanceCore` をアタッチするのが最短。

**SSM Agent**
- Amazon Linux 2 / AL2023 はプリインストール済みでそのまま動く
- Ubuntu の場合は `snap install amazon-ssm-agent` が必要

**ネットワーク**
- パブリックIPは **不要**（SSMはアウトバウンドのみ）
- ただし EC2 から SSM エンドポイントへの HTTPS アウトバウンド(443)が必要

| 方式 | 要件 |
|---|---|
| Internet Gateway 経由 | EC2 に NAT Gateway or Internet Gateway のルートがあること |
| VPC エンドポイント経由 | 後述 |

**セキュリティグループ**
- インバウンド: **全て不要**（SSHの22番も不要）
- アウトバウンド: 443 (HTTPS) → `0.0.0.0/0` or SSMエンドポイントのみ

---

### 2. Aurora Serverless v2

**セキュリティグループ**

```
インバウンド: 5432 (PostgreSQL)
ソース: 踏み台EC2のセキュリティグループID  ← IPではなくSGで紐付けること
```

踏み台のSGを直接ソースに指定するのが定石。IPだと変動リスクがある。

**サブネット**
- Aurora はプライベートサブネットに配置
- パブリックアクセス: **無効**

---

### 3. VPCエンドポイント（推奨）

NAT Gateway を使わずプライベートサブネットだけで完結させるなら必須。

| エンドポイント | 用途 |
|---|---|
| `com.amazonaws.{region}.ssm` | SSM コントロールプレーン |
| `com.amazonaws.{region}.ssmmessages` | セッションデータ転送 |
| `com.amazonaws.{region}.ec2messages` | EC2 ↔ SSM 通信 |

いずれもインターフェース型エンドポイント。踏み台が置かれるサブネットと同じVPCに作成。

---

### 4. ローカルPC側（操作者）の IAM 権限

```json
{
  "Effect": "Allow",
  "Action": [
    "ssm:StartSession",
    "ssm:TerminateSession",
    "ssm:DescribeSessions",
    "ssm:GetConnectionStatus",
    "ec2:DescribeInstances"
  ],
  "Resource": "*"
}
```

`ssm:StartSession` の `Resource` はインスタンスARNに絞るとよりセキュア。

```json
"Resource": "arn:aws:ec2:ap-northeast-1:123456789012:instance/i-xxxxxxxxx"
```

---

### 全体の通信フロー

```
ローカルPC
  │
  │ HTTPS (443)  ← SSM Session Manager API
  ▼
AWS SSM コントロールプレーン
  │
  │ SSM Agent 経由
  ▼
EC2 踏み台 (プライベートサブネット)
  │
  │ TCP 5432  ← VPC内部通信
  ▼
Aurora Serverless v2 (プライベートサブネット)
```

ローカルPC ↔ Aurora 間で直接TCPは張らず、**全てHTTPS経由でSSMがトンネリング**している点が重要。踏み台のSGにSSHの穴を開ける必要が一切ない。