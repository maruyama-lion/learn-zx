#!/usr/bin/env zx
/**
 * db-tunnel.mjs
 *
 * SSM セッションマネージャー経由で Aurora Serverless v2 (PostgreSQL) への
 * ポートフォワーディングトンネルを確立・管理するスクリプト。
 * Secrets Manager から DB接続情報を取得し、psql コマンドを自動生成する。
 *
 * 前提条件:
 *   - AWS CLI v2 インストール済み
 *   - Session Manager Plugin インストール済み
 *   - EC2 踏み台サーバーに SSM Agent + AmazonSSMManagedInstanceCore ロール
 *   - IAM: ssm:StartSession / secretsmanager:GetSecretValue / kms:Decrypt 権限
 *   - zx v8+
 *
 * 使い方:
 *   chmod +x db-tunnel.mjs
 *   ./db-tunnel.mjs [--profile <aws-profile>] [--region <region>]
 *                   [--instance <ec2-instance-id>]
 *                   [--secret <secret-name-or-arn>]
 *                   [--local-port <local-port>]
 */

import { createServer }                    from "net";
import { writeFileSync, existsSync,
         unlinkSync, readFileSync }        from "fs";
import { resolve }                         from "path";

// ─── 設定 ─────────────────────────────────────────────────────────────────────

const CONFIG = {
  profile:    argv.profile       ?? process.env.AWS_PROFILE          ?? "default",
  region:     argv.region        ?? process.env.AWS_REGION           ?? "ap-northeast-1",
  instanceId: argv.instance      ?? process.env.BASTION_INSTANCE_ID  ?? "",
  secretId:   argv.secret        ?? process.env.DB_SECRET_ID         ?? "",
  localPort:  Number(argv["local-port"] ?? process.env.LOCAL_PORT    ?? 15432),
  pidFile:    resolve(process.env.HOME ?? "/tmp", ".db-tunnel.pid"),
};

// Secrets Manager から取得した値を格納 (後工程で参照)
let SECRET = null;

// ─── ロガー ───────────────────────────────────────────────────────────────────

const log  = (msg)    => console.log(chalk.cyan(`[tunnel] ${msg}`));
const warn = (msg)    => console.warn(chalk.yellow(`[warn]   ${msg}`));
const fail = (msg, e) => { console.error(chalk.red(`[error]  ${msg}`)); if (e) console.error(e); };
const ok   = (msg)    => console.log(chalk.green(`[ok]     ${msg}`));

// ─── ユーティリティ ────────────────────────────────────────────────────────────

/** ローカルポートが既に使用中か確認 */
async function isPortInUse(port) {
  return new Promise((res) => {
    const s = createServer();
    s.once("error", () => res(true));
    s.once("listening", () => { s.close(); res(false); });
    s.listen(port);
  });
}

/** 必須コマンドの存在確認 */
async function checkDependencies() {
  log("依存コマンドの確認中...");
  const deps = {
    "aws":                    "AWS CLI v2 をインストールしてください。",
    "session-manager-plugin": "https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html",
  };
  for (const [cmd, hint] of Object.entries(deps)) {
    try {
      await $`which ${cmd}`.quiet();
    } catch {
      throw new Error(`'${cmd}' が見つかりません。\n  → ${hint}`);
    }
  }
  ok("依存コマンド OK");
}

/** AWS 認証確認 */
async function checkAwsAuth() {
  log("AWS 認証の確認中...");
  try {
    const res = await $`aws sts get-caller-identity
      --profile ${CONFIG.profile}
      --region  ${CONFIG.region}
      --output  json`.quiet();
    const id = JSON.parse(res.stdout);
    ok(`認証済み: ${id.Arn}`);
  } catch {
    throw new Error(
      `AWS 認証に失敗しました (profile: ${CONFIG.profile})。\n` +
      `  aws configure --profile ${CONFIG.profile} を実行してください。`
    );
  }
}

/** Secrets Manager からシークレットを取得・検証 */
async function fetchSecret() {
  log(`Secrets Manager からシークレット取得中: ${CONFIG.secretId}`);
  let raw;
  try {
    const res = await $`aws secretsmanager get-secret-value
      --secret-id  ${CONFIG.secretId}
      --query      SecretString
      --output     text
      --profile    ${CONFIG.profile}
      --region     ${CONFIG.region}`.quiet();
    raw = res.stdout.trim();
  } catch (e) {
    // エラーメッセージから原因を判別して案内
    const msg = e.stderr ?? "";
    if (msg.includes("AccessDeniedException")) {
      throw new Error(
        "Secrets Manager へのアクセスが拒否されました。\n" +
        "  必要な IAM 権限: secretsmanager:GetSecretValue / kms:Decrypt\n" +
        `  シークレット ARN: ${CONFIG.secretId}`
      );
    }
    if (msg.includes("ResourceNotFoundException")) {
      throw new Error(`シークレットが見つかりません: ${CONFIG.secretId}`);
    }
    throw new Error(`Secrets Manager 取得エラー: ${msg}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("シークレットの JSON パースに失敗しました。SecretString の形式を確認してください。");
  }

  // 必須フィールドの存在確認
  const required = ["host", "port", "username", "password", "dbname"];
  const absent   = required.filter((k) => !parsed[k]);
  if (absent.length) {
    throw new Error(
      `シークレットに必須フィールドがありません: ${absent.join(", ")}\n` +
      `  期待するキー: ${required.join(", ")}`
    );
  }

  SECRET = {
    host:     parsed.host,
    port:     Number(parsed.port),
    username: parsed.username,
    password: parsed.password,
    dbname:   parsed.dbname,
  };

  ok(`シークレット取得成功 (host: ${SECRET.host}, dbname: ${SECRET.dbname})`);
}

/** EC2 インスタンスの稼働確認 */
async function checkInstance() {
  log(`EC2 インスタンス確認中: ${CONFIG.instanceId}`);
  const res = await $`aws ec2 describe-instances
    --instance-ids ${CONFIG.instanceId}
    --query        "Reservations[0].Instances[0].State.Name"
    --output       text
    --profile      ${CONFIG.profile}
    --region       ${CONFIG.region}`.quiet();

  const state = res.stdout.trim();
  if (state !== "running") {
    throw new Error(`EC2 インスタンスが running 状態ではありません (現在: ${state})`);
  }
  ok(`EC2 インスタンス状態: ${state}`);
}

/** 多重起動チェック & PID ファイル書き込み */
function writePidFile() {
  if (existsSync(CONFIG.pidFile)) {
    const oldPid = parseInt(readFileSync(CONFIG.pidFile, "utf-8").trim(), 10);
    try {
      process.kill(oldPid, 0);
      throw new Error(
        `既にトンネルが起動しています (PID: ${oldPid})。\n` +
        `  終了: kill ${oldPid}  または  rm ${CONFIG.pidFile} して再実行`
      );
    } catch (e) {
      if (e.code === "ESRCH") {
        warn(`古い PID ファイルを削除します (PID: ${oldPid})`);
        unlinkSync(CONFIG.pidFile);
      } else {
        throw e;
      }
    }
  }
  writeFileSync(CONFIG.pidFile, String(process.pid));
  log(`PID ファイル書き込み: ${CONFIG.pidFile} (PID: ${process.pid})`);
}

/** PID ファイル削除 */
function cleanPidFile() {
  if (existsSync(CONFIG.pidFile)) {
    unlinkSync(CONFIG.pidFile);
    log("PID ファイルを削除しました");
  }
}

// ─── メイン ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold("\n🔐 Aurora SSM トンネル起動スクリプト\n"));

  // ─ 入力検証
  const missing = [];
  if (!CONFIG.instanceId) missing.push("--instance (または BASTION_INSTANCE_ID)");
  if (!CONFIG.secretId)   missing.push("--secret   (または DB_SECRET_ID)");
  if (missing.length) {
    fail("必須パラメータが未設定です:\n  " + missing.join("\n  "));
    process.exit(1);
  }

  // ─ 事前チェック (並列化できるものはまとめて実行)
  await checkDependencies();
  await checkAwsAuth();
  await Promise.all([
    fetchSecret(),      // Secrets Manager
    checkInstance(),    // EC2 状態
  ]);

  if (await isPortInUse(CONFIG.localPort)) {
    fail(`ローカルポート ${CONFIG.localPort} は既に使用中です。--local-port で別のポートを指定してください。`);
    process.exit(1);
  }

  writePidFile();

  // ─ 接続情報の表示 (パスワードはマスク)
  console.log(chalk.bold("\n📋 接続情報"));
  console.log(`  AWS Profile  : ${chalk.white(CONFIG.profile)}`);
  console.log(`  Region       : ${chalk.white(CONFIG.region)}`);
  console.log(`  Secret ID    : ${chalk.white(CONFIG.secretId)}`);
  console.log(`  Bastion EC2  : ${chalk.white(CONFIG.instanceId)}`);
  console.log(`  Aurora Host  : ${chalk.white(SECRET.host)}:${SECRET.port}`);
  console.log(`  Database     : ${chalk.white(SECRET.dbname)}`);
  console.log(`  User         : ${chalk.white(SECRET.username)}`);
  console.log(`  Password     : ${chalk.gray("*".repeat(12))} (Secrets Manager から取得)`);
  console.log(`  Local Port   : ${chalk.white(CONFIG.localPort)}`);

  // psql 接続コマンドを表示 (PGPASSWORD 環境変数を使ってパスワード入力を省略)
  console.log(chalk.bold("\n🖥  接続コマンド (別ターミナルで実行)"));
  console.log(chalk.green(
    `  PGPASSWORD='${SECRET.password}' \\\n` +
    `  psql -h 127.0.0.1 -p ${CONFIG.localPort} -U ${SECRET.username} -d ${SECRET.dbname}\n`
  ));

  // ─ SSM ポートフォワーディング開始
  log("SSM セッションを開始します...");

  const ssmProcess = $`aws ssm start-session
    --target        ${CONFIG.instanceId}
    --document-name AWS-StartPortForwardingSessionToRemoteHost
    --parameters    host=${SECRET.host},portNumber=${String(SECRET.port)},localPortNumber=${String(CONFIG.localPort)}
    --profile       ${CONFIG.profile}
    --region        ${CONFIG.region}`.nothrow();

  ssmProcess.stdout.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) log(line);
  });
  ssmProcess.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) warn(line);
  });

  // ─ クリーンアップ
  let cleanupDone = false;

  async function cleanup(signal) {
    if (cleanupDone) return;
    cleanupDone = true;

    console.log(chalk.bold(`\n\n🛑 シグナル受信 (${signal}) — クリーンアップ中...\n`));

    // 1. SSM プロセス終了
    try {
      ssmProcess.kill("SIGTERM");
      log("SSM プロセスに SIGTERM を送信しました");
      await Promise.race([
        ssmProcess,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 3_000)),
      ]).catch(async () => {
        warn("タイムアウト — SIGKILL で強制終了します");
        ssmProcess.kill("SIGKILL");
      });
    } catch {
      // 既に終了済みなら無視
    }

    // 2. SSM セッションを API から明示的に終了
    try {
      log("残存 SSM セッションを確認中...");
      const listRes = await $`aws ssm describe-sessions
        --state  Active
        --filter key=Target,value=${CONFIG.instanceId}
        --query  "Sessions[*].SessionId"
        --output text
        --profile ${CONFIG.profile}
        --region  ${CONFIG.region}`.quiet().nothrow();

      const sessionIds = listRes.stdout.trim().split(/\s+/).filter(Boolean);
      if (sessionIds.length > 0) {
        await Promise.all(
          sessionIds.map(async (sid) => {
            await $`aws ssm terminate-session
              --session-id ${sid}
              --profile    ${CONFIG.profile}
              --region     ${CONFIG.region}`.quiet().nothrow();
            ok(`SSM セッション終了: ${sid}`);
          })
        );
      } else {
        log("アクティブな SSM セッションなし (既に終了済み)");
      }
    } catch (e) {
      warn(`SSM セッションクリーンアップ中にエラー: ${e.message}`);
    }

    // 3. PID ファイル削除
    cleanPidFile();

    ok("クリーンアップ完了\n");
    process.exit(0);
  }

  // ─ シグナルハンドラー
  process.on("SIGINT",  () => cleanup("SIGINT"));   // Ctrl+C
  process.on("SIGTERM", () => cleanup("SIGTERM"));  // kill
  process.on("SIGHUP",  () => cleanup("SIGHUP"));   // ターミナル切断

  // ─ SSM プロセスが予期せず終了した場合
  ssmProcess
    .then(() => { if (!cleanupDone) { warn("SSM プロセスが予期せず終了しました"); cleanup("PROCESS_EXIT"); } })
    .catch((e) => { if (!cleanupDone) { fail("SSM プロセスがエラーで終了しました", e); cleanup("PROCESS_ERROR"); } });

  ok("トンネル確立完了 — Ctrl+C で終了\n");
  await ssmProcess;
}

main().catch((e) => {
  fail("予期しないエラー:", e);
  cleanPidFile();
  process.exit(1);
});
