import { $, argv, chalk } from 'zx';
import { createServer } from 'net';
import { writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ─── 型定義 ────────────────────────────────────────────────────────────────────

interface Config {
  profile: string;
  region: string;
  instanceId: string;
  secretId: string;
  localPort: number;
  pidFile: string;
}

interface Secret {
  host: string;
  port: number;
  username: string;
  password: string;
  dbname: string;
}

interface PidFile {
  pid: number;
  sessionId: string | null;
}

// ─── 設定 ──────────────────────────────────────────────────────────────────────

const CONFIG: Config = {
  profile:    String(argv.profile        ?? process.env.AWS_PROFILE         ?? 'default'),
  region:     String(argv.region         ?? process.env.AWS_REGION          ?? 'ap-northeast-1'),
  instanceId: String(argv.instance       ?? process.env.BASTION_INSTANCE_ID ?? ''),
  secretId:   String(argv.secret         ?? process.env.DB_SECRET_ID        ?? ''),
  localPort:  Number(argv['local-port']  ?? process.env.LOCAL_PORT          ?? 15432),
  pidFile:    resolve(process.env.HOME ?? '/tmp', '.db-tunnel.pid'),
};

let SECRET: Secret | null = null;

// ─── ロガー ────────────────────────────────────────────────────────────────────

const log  = (msg: string) => console.log(chalk.cyan(`[tunnel] ${msg}`));
const warn = (msg: string) => console.warn(chalk.yellow(`[warn]   ${msg}`));
const fail = (msg: string, e?: unknown) => {
  console.error(chalk.red(`[error]  ${msg}`));
  if (e) console.error(e);
};
const ok = (msg: string) => console.log(chalk.green(`[ok]     ${msg}`));

// ─── チェック系 ────────────────────────────────────────────────────────────────

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(true));
    s.once('listening', () => { s.close(); res(false); });
    s.listen(port);
  });
}

async function checkDependencies(): Promise<void> {
  log('依存コマンドの確認中...');
  const deps: Record<string, string> = {
    'aws':                    'AWS CLI v2 をインストールしてください。',
    'session-manager-plugin': 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
  };
  for (const [cmd, hint] of Object.entries(deps)) {
    try {
      await $`which ${cmd}`.quiet();
    } catch {
      throw new Error(`'${cmd}' が見つかりません。\n  → ${hint}`);
    }
  }
  ok('依存コマンド OK');
}

async function checkAwsAuth(): Promise<void> {
  log('AWS 認証の確認中...');
  try {
    const res = await $`aws sts get-caller-identity --profile ${CONFIG.profile} --region ${CONFIG.region} --output json`.quiet();
    const id = JSON.parse(res.stdout) as { Arn: string };
    ok(`認証済み: ${id.Arn}`);
  } catch {
    throw new Error(
      `AWS 認証に失敗しました (profile: ${CONFIG.profile})。\n` +
      `  aws configure --profile ${CONFIG.profile} を実行してください。`
    );
  }
}

async function fetchSecret(): Promise<void> {
  log(`Secrets Manager からシークレット取得中: ${CONFIG.secretId}`);
  let raw: string;
  try {
    const res = await $`aws secretsmanager get-secret-value --secret-id ${CONFIG.secretId} --query SecretString --output text --profile ${CONFIG.profile} --region ${CONFIG.region}`.quiet();
    raw = res.stdout.trim();
  } catch (e) {
    const msg = (e as { stderr?: string }).stderr ?? '';
    if (msg.includes('AccessDeniedException')) {
      throw new Error(
        'Secrets Manager へのアクセスが拒否されました。\n' +
        '  必要な IAM 権限: secretsmanager:GetSecretValue / kms:Decrypt\n' +
        `  シークレット: ${CONFIG.secretId}`
      );
    }
    if (msg.includes('ResourceNotFoundException')) {
      throw new Error(`シークレットが見つかりません: ${CONFIG.secretId}`);
    }
    throw new Error(`Secrets Manager 取得エラー: ${msg}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('シークレットの JSON パースに失敗しました。SecretString の形式を確認してください。');
  }

  const required = ['host', 'port', 'username', 'password', 'dbname'] as const;
  const absent = required.filter((k) => !parsed[k]);
  if (absent.length) {
    throw new Error(
      `シークレットに必須フィールドがありません: ${absent.join(', ')}\n` +
      `  期待するキー: ${required.join(', ')}`
    );
  }

  SECRET = {
    host:     String(parsed.host),
    port:     Number(parsed.port),
    username: String(parsed.username),
    password: String(parsed.password),
    dbname:   String(parsed.dbname),
  };

  ok(`シークレット取得成功 (host: ${SECRET.host}, dbname: ${SECRET.dbname})`);
}

async function checkInstance(): Promise<void> {
  log(`EC2 インスタンス確認中: ${CONFIG.instanceId}`);
  const res = await $`aws ec2 describe-instances --instance-ids ${CONFIG.instanceId} --query "Reservations[0].Instances[0].State.Name" --output text --profile ${CONFIG.profile} --region ${CONFIG.region}`.quiet();
  const state = res.stdout.trim();
  if (state !== 'running') {
    throw new Error(`EC2 インスタンスが running 状態ではありません (現在: ${state})`);
  }
  ok(`EC2 インスタンス状態: ${state}`);
}

// ─── PID ファイル ──────────────────────────────────────────────────────────────

function writePidFile(): void {
  if (existsSync(CONFIG.pidFile)) {
    const saved = JSON.parse(readFileSync(CONFIG.pidFile, 'utf-8')) as PidFile;
    try {
      process.kill(saved.pid, 0);
      throw new Error(
        `既にトンネルが起動しています (PID: ${saved.pid})。\n` +
        `  終了: kill ${saved.pid}  または  rm ${CONFIG.pidFile} して再実行`
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
        warn(`古い PID ファイルを削除します (PID: ${saved.pid})`);
        unlinkSync(CONFIG.pidFile);
      } else {
        throw e;
      }
    }
  }
  writeFileSync(CONFIG.pidFile, JSON.stringify({ pid: process.pid, sessionId: null } as PidFile));
  log(`PID ファイル書き込み: ${CONFIG.pidFile} (PID: ${process.pid})`);
}

function updatePidFileSessionId(sessionId: string): void {
  if (!existsSync(CONFIG.pidFile)) return;
  const saved = JSON.parse(readFileSync(CONFIG.pidFile, 'utf-8')) as PidFile;
  writeFileSync(CONFIG.pidFile, JSON.stringify({ ...saved, sessionId }));
  log(`SessionId を記録しました: ${sessionId}`);
}

function readSessionId(): string | null {
  if (!existsSync(CONFIG.pidFile)) return null;
  try {
    const saved = JSON.parse(readFileSync(CONFIG.pidFile, 'utf-8')) as PidFile;
    return saved.sessionId ?? null;
  } catch {
    return null;
  }
}

function cleanPidFile(): void {
  if (existsSync(CONFIG.pidFile)) {
    unlinkSync(CONFIG.pidFile);
    log('PID ファイルを削除しました');
  }
}

// ─── メイン ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(chalk.bold('\n🔐 Aurora SSM トンネル起動スクリプト\n'));

  const missing: string[] = [];
  if (!CONFIG.instanceId) missing.push('--instance (または BASTION_INSTANCE_ID)');
  if (!CONFIG.secretId)   missing.push('--secret   (または DB_SECRET_ID)');
  if (missing.length) {
    fail('必須パラメータが未設定です:\n  ' + missing.join('\n  '));
    process.exit(1);
  }

  await checkDependencies();
  await checkAwsAuth();
  await Promise.all([fetchSecret(), checkInstance()]);

  if (await isPortInUse(CONFIG.localPort)) {
    fail(`ローカルポート ${CONFIG.localPort} は既に使用中です。--local-port で別のポートを指定してください。`);
    process.exit(1);
  }

  writePidFile();

  console.log(chalk.bold('\n📋 接続情報'));
  console.log(`  AWS Profile  : ${chalk.white(CONFIG.profile)}`);
  console.log(`  Region       : ${chalk.white(CONFIG.region)}`);
  console.log(`  Secret ID    : ${chalk.white(CONFIG.secretId)}`);
  console.log(`  Bastion EC2  : ${chalk.white(CONFIG.instanceId)}`);
  console.log(`  Aurora Host  : ${chalk.white(SECRET!.host)}:${SECRET!.port}`);
  console.log(`  Database     : ${chalk.white(SECRET!.dbname)}`);
  console.log(`  User         : ${chalk.white(SECRET!.username)}`);
  console.log(`  Password     : ${chalk.gray('*'.repeat(12))} (Secrets Manager から取得)`);
  console.log(`  Local Port   : ${chalk.white(CONFIG.localPort)}`);
  console.log(chalk.bold('\n🖥  接続コマンド (別ターミナルで実行)'));
  console.log(chalk.green(
    `  PGPASSWORD='${SECRET!.password}' \\\n` +
    `  psql -h 127.0.0.1 -p ${CONFIG.localPort} -U ${SECRET!.username} -d ${SECRET!.dbname}\n`
  ));

  log('SSM セッションを開始します...');

  const sessionStartedAt = new Date();

  const ssmProcess = $`aws ssm start-session --target ${CONFIG.instanceId} --document-name AWS-StartPortForwardingSessionToRemoteHost --parameters host=${SECRET!.host},portNumber=${String(SECRET!.port)},localPortNumber=${String(CONFIG.localPort)} --profile ${CONFIG.profile} --region ${CONFIG.region}`.nothrow();

  ssmProcess.stdout.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) log(line);
  });
  ssmProcess.stderr.on('data', (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) warn(line);
  });

  // start-session は SessionId を stdout に出さないため、起動後に describe-sessions で特定する
  async function resolveMySessionId(): Promise<void> {
    await new Promise<void>((r) => setTimeout(r, 2_000));
    try {
      const whoami = await $`aws sts get-caller-identity --query Arn --output text --profile ${CONFIG.profile} --region ${CONFIG.region}`.quiet();
      const myArn = whoami.stdout.trim();

      const listRes = await $`aws ssm describe-sessions --state Active --filter key=Target,value=${CONFIG.instanceId} --query "Sessions[*].{Id:SessionId,Owner:Owner,Start:StartDate}" --output json --profile ${CONFIG.profile} --region ${CONFIG.region}`.quiet();
      const sessions = JSON.parse(listRes.stdout.trim()) as Array<{ Id: string; Owner: string; Start: string }>;

      const mine = sessions
        .filter((s) => s.Owner === myArn && new Date(s.Start) >= sessionStartedAt)
        .sort((a, b) => new Date(b.Start).getTime() - new Date(a.Start).getTime())[0];

      if (mine) {
        updatePidFileSessionId(mine.Id);
        ok(`自分の SSM セッションを特定しました: ${mine.Id}`);
      } else {
        warn('自分の SSM セッションを特定できませんでした (クリーンアップ時に手動確認が必要な場合があります)');
      }
    } catch (e) {
      warn(`SessionId 取得中にエラー: ${(e as Error).message}`);
    }
  }

  resolveMySessionId(); // トンネル稼働をブロックしないよう非同期で実行

  let cleanupDone = false;

  async function cleanup(signal: string): Promise<void> {
    if (cleanupDone) return;
    cleanupDone = true;

    console.log(chalk.bold(`\n\n🛑 シグナル受信 (${signal}) — クリーンアップ中...\n`));

    // 1. SSM プロセス終了
    try {
      ssmProcess.kill('SIGTERM');
      log('SSM プロセスに SIGTERM を送信しました');
      await Promise.race([
        ssmProcess,
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3_000)),
      ]).catch(async () => {
        warn('タイムアウト — SIGKILL で強制終了します');
        ssmProcess.kill('SIGKILL');
      });
    } catch {
      // 既に終了済みなら無視
    }

    // 2. 自分の SSM セッションのみを terminate
    try {
      const mySessionId = readSessionId();
      if (mySessionId) {
        log(`SSM セッションを終了します: ${mySessionId}`);
        await $`aws ssm terminate-session --session-id ${mySessionId} --profile ${CONFIG.profile} --region ${CONFIG.region}`.quiet().nothrow();
        ok(`SSM セッション終了: ${mySessionId}`);
      } else {
        // SessionId が記録できていない場合は IAM ARN + 起動時刻でフォールバック
        warn('記録された SessionId がありません。IAM ARN で自分のセッションを特定します...');
        const whoami = await $`aws sts get-caller-identity --query Arn --output text --profile ${CONFIG.profile} --region ${CONFIG.region}`.quiet().nothrow();
        const myArn = whoami.stdout.trim();

        const listRes = await $`aws ssm describe-sessions --state Active --filter key=Target,value=${CONFIG.instanceId} --query "Sessions[*].{Id:SessionId,Owner:Owner,Start:StartDate}" --output json --profile ${CONFIG.profile} --region ${CONFIG.region}`.quiet().nothrow();
        const sessions = JSON.parse(listRes.stdout.trim() || '[]') as Array<{ Id: string; Owner: string; Start: string }>;
        const mine = sessions.filter((s) => s.Owner === myArn && new Date(s.Start) >= sessionStartedAt);

        if (mine.length > 0) {
          await Promise.all(mine.map(async (s) => {
            await $`aws ssm terminate-session --session-id ${s.Id} --profile ${CONFIG.profile} --region ${CONFIG.region}`.quiet().nothrow();
            ok(`SSM セッション終了 (フォールバック): ${s.Id}`);
          }));
        } else {
          warn('終了すべき自分のセッションが見つかりませんでした (既に終了済みの可能性があります)');
        }
      }
    } catch (e) {
      warn(`SSM セッションクリーンアップ中にエラー: ${(e as Error).message}`);
    }

    // 3. PID ファイル削除
    cleanPidFile();
    ok('クリーンアップ完了\n');
    process.exit(0);
  }

  process.on('SIGINT',  () => cleanup('SIGINT'));   // Ctrl+C
  process.on('SIGTERM', () => cleanup('SIGTERM'));  // kill
  process.on('SIGHUP',  () => cleanup('SIGHUP'));   // ターミナル切断

  ssmProcess
    .then(() => { if (!cleanupDone) { warn('SSM プロセスが予期せず終了しました'); cleanup('PROCESS_EXIT'); } })
    .catch((e: unknown) => { if (!cleanupDone) { fail('SSM プロセスがエラーで終了しました', e); cleanup('PROCESS_ERROR'); } });

  ok('トンネル確立完了 — Ctrl+C で終了\n');
  await ssmProcess;
}

main().catch((e: unknown) => {
  fail('予期しないエラー:', e);
  cleanPidFile();
  process.exit(1);
});
