## 質問

```
cdkでec2及びauroraを構築している場合、IAMの権限は自動で付与されるか？
```

---

**結論: 自動では付与されません。** CDKで EC2・Aurora を作っても、IAM権限は明示的に書かないと付与されません。

ただし CDK には**ヘルパーメソッド**が用意されており、手書きの IAM JSON よりずっと簡潔に書けます。

---

### 何が自動で、何が手動か

| 項目 | 自動 | 手動 |
|---|:---:|:---:|
| EC2 インスタンスプロファイル（ロール自体）の作成 | ✅ | |
| `AmazonSSMManagedInstanceCore` のアタッチ | ❌ | 要追加 |
| Secrets Manager への読み取り権限 | ❌ | 要追加 |
| KMS 復号権限 | ❌ | 要追加 |
| Aurora の暗号化キー（KMS）作成 | ❌ | 要追加 |

EC2 の `role` はCDKが自動生成しますが、**中身は空**です。

---

### CDK での正しい書き方

```typescript
import * as cdk    from 'aws-cdk-lib';
import * as ec2    from 'aws-cdk-lib/aws-ec2';
import * as rds    from 'aws-cdk-lib/aws-rds';
import * as kms    from 'aws-cdk-lib/aws-kms';
import * as iam    from 'aws-cdk-lib/aws-iam';
import * as sm     from 'aws-cdk-lib/aws-secretsmanager';

export class AuroraStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: false });

    // ── KMS キー (Aurora 暗号化用) ───────────────────────────────────────
    const dbKey = new kms.Key(this, 'AuroraKey', {
      description:       'Aurora Serverless v2 encryption key',
      enableKeyRotation: true,   // 年次自動ローテーション
      removalPolicy:     cdk.RemovalPolicy.RETAIN,
    });

    // ── Aurora Serverless v2 ─────────────────────────────────────────────
    const cluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_2,
      }),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      vpc,
      vpcSubnets:    { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      storageEncrypted: true,
      storageEncryptionKey: dbKey,  // ← カスタマー管理キーで暗号化
      // credentials は省略すると CDK が自動で Secrets Manager に作成してくれる
      credentials: rds.Credentials.fromGeneratedSecret('dbadmin', {
        secretName: 'aurora/mydb/credentials',
        encryptionKey: dbKey,       // ← シークレット自体も同じキーで暗号化
      }),
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // ── 踏み台 EC2 ───────────────────────────────────────────────────────
    const bastion = new ec2.BastionHostLinux(this, 'Bastion', {
      vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // BastionHostLinux は内部で SSM 用ロールとインスタンスプロファイルを作るが
      // AmazonSSMManagedInstanceCore は自動でアタッチされる ✅
    });

    // ── SSM 権限: BastionHostLinux は自動付与されるが、
    //    通常の ec2.Instance を使う場合は以下が必要 ─────────────────────
    // bastion.instance.role.addManagedPolicy(
    //   iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    // );

    // ── Secrets Manager 読み取り権限 → EC2 ロールに付与 ──────────────────
    // grant 系メソッドが最もシンプル
    cluster.secret?.grantRead(bastion.role);
    //  ↑ これ1行で以下を自動生成:
    //    - secretsmanager:GetSecretValue
    //    - secretsmanager:DescribeSecret
    //    - kms:Decrypt (シークレットの KMS キーに対して)

    // ローカルPCの操作者 IAM ユーザー/ロールにも同様に付与する場合:
    // const devRole = iam.Role.fromRoleName(this, 'DevRole', 'your-dev-role');
    // cluster.secret?.grantRead(devRole);

    // ── EC2 → Aurora のセキュリティグループ許可 ───────────────────────────
    cluster.connections.allowFrom(
      bastion.connections,
      ec2.Port.tcp(5432),
      'Allow bastion to Aurora PostgreSQL',
    );

    // ── 出力 ─────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'BastionInstanceId', {
      value:       bastion.instanceId,
      description: 'BASTION_INSTANCE_ID に設定する値',
    });
    new cdk.CfnOutput(this, 'SecretArn', {
      value:       cluster.secret?.secretArn ?? '(no secret)',
      description: 'DB_SECRET_ID に設定する値',
    });
  }
}
```

---

### ポイント整理

**`BastionHostLinux` vs `ec2.Instance`**

`BastionHostLinux` を使うと `AmazonSSMManagedInstanceCore` が自動アタッチされます。素の `ec2.Instance` を使っている場合は `addManagedPolicy` が必要です。

**`grantRead()` が便利な理由**

`cluster.secret?.grantRead(bastion.role)` の1行が、以下の手書きと等価です。

```typescript
// grantRead が内部でやっていること (書かなくてよい)
bastionRole.addToPolicy(new iam.PolicyStatement({
  actions:   ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
  resources: [cluster.secret!.secretArn],
}));
dbKey.grantDecrypt(bastionRole); // KMS も自動で追加
```

**ローカルPCからの `aws secretsmanager get-secret-value`**

スクリプトを手元から実行する場合、操作者の IAM ユーザー/ロールにも同じ `grantRead` が必要です。CDK は EC2 ロールには付与しますが、**開発者の IAM には付与しません。** `fromRoleName` や `fromUserName` で取得して明示的に追加してください。
