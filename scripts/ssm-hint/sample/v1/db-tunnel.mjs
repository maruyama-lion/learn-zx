#!/usr/bin/env zx
/**
 * db-tunnel.mjs
 *
 * SSM セッションマネージャー経由で Aurora Serverless v2 (PostgreSQL) への
 * ポートフォワーディングトンネルを確立・管理するスクリプト。
 *
 * 前提条件:
 *   - AWS CLI v2 インストール済み
 *   - Session Manager Plugin インストール済み
 *     https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
 *   - EC2 踏み台サーバーに SSM Agent が動作していること
 *   - IAM: ssm:StartSession / ssm:TerminateSession 権限
 *   - zx v8+ インストール済み  (npx zx db-tunnel.mjs でも可)
 *
 * 使い方:
 *   chmod +x db-tunnel.mjs
 *   ./db-tunnel.mjs [--profile <aws-profile>] [--region <region>]
 *                   [--instance <ec2-instance-id>] [--host <aurora-host>]
 *                   [--port <aurora-port>] [--local-port <local-port>]
 */

import { createServer } from "net";
import { writeFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";

// ─── 設定 ─────────────────────────────────────────────────────────────────────

const CONFIG = {
  // AWS設定 (環境変数 or CLIオプションで上書き可)
  profile:       argv.profile    ?? process.env.AWS_PROFILE    ?? "default",
  region:        argv.region     ?? process.env.AWS_REGION     ?? "ap-northeast-1",

  // 踏み台EC2インスタンスID  例: i-0123456789abcdef0
  instanceId:    argv.instance   ?? process.env.BASTION_INSTANCE_ID ?? "",

  // Aurora エンドポイント (VPC 内部から見えるホスト名)
  dbHost:        argv.host       ?? process.env.DB_HOST        ?? "",
  dbPort:        Number(argv.port ?? process.env.DB_PORT       ?? 5432),

  // ローカル待受ポート
  localPort:     Number(argv["local-port"] ?? process.env.LOCAL_PORT ?? 15432),

  // PIDファイル (多重起動防止)
  pidFile:       resolve(process.env.HOME ?? "/tmp", ".db-tunnel.pid"),
};

// ─── ユーティリティ ────────────────────────────────────────────────────────────

const log  = (msg)       => console.log(chalk.cyan(`[tunnel] ${msg}`));
const warn = (msg)       => console.warn(chalk.yellow(`[warn]   ${msg}`));
const err  = (msg, e)    => { console.error(chalk.red(`[error]  ${msg}`)); if (e) console.error(e); };
const ok   = (msg)       => console.log(chalk.green(`[ok]     ${msg}`));

/** ローカルポートが既に使用中か確認 */
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => { server.close(); resolve(false); });
    server.listen(port);
  });
}

/** 必須コマンドの存在確認 */
async function checkDependencies() {
  log("依存コマンドの確認中...");
  const deps = ["aws", "session-manager-plugin"];
  for (const cmd of deps) {
    try {
      await $`which ${cmd}`.quiet();
    } catch {
      throw new Error(
        `'${cmd}' が見つかりません。\n` +
        (cmd === "session-manager-plugin"
          ? "  → https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html"
          : "  → AWS CLI v2 をインストールしてください。")
      );
    }
  }
  ok("依存コマンド OK");
}

/** AWS認証・権限の事前確認 */
async function checkAwsAuth() {
  log("AWS認証の確認中...");
  try {
    const res = await $`aws sts get-caller-identity --profile ${CONFIG.profile} --region ${CONFIG.region} --output json`.quiet();
    const identity = JSON.parse(res.stdout);
    ok(`認証済み: ${identity.Arn}`);
  } catch (e) {
    throw new Error(`AWS 認証に失敗しました (profile: ${CONFIG.profile})。\n  aws configure --profile ${CONFIG.profile} を実行してください。`);
  }
}

/** EC2インスタンスの状態確認 */
async function checkInstance() {
  log(`EC2 インスタンス確認中: ${CONFIG.instanceId}`);
  const res = await $`aws ec2 describe-instances
    --instance-ids ${CONFIG.instanceId}
    --query "Reservations[0].Instances[0].State.Name"
    --output text
    --profile ${CONFIG.profile}
    --region ${CONFIG.region}`.quiet();

  const state = res.stdout.trim();
  if (state !== "running") {
    throw new Error(`EC2 インスタンスが running 状態ではありません (現在: ${state})`);
  }
  ok(`EC2 インスタンス状態: ${state}`);
}

/** 多重起動チェック & PIDファイル書き込み */
function writePidFile() {
  if (existsSync(CONFIG.pidFile)) {
    const oldPid = parseInt(fs.readFileSync(CONFIG.pidFile, "utf-8").trim(), 10);
    try {
      process.kill(oldPid, 0); // プロセス存在確認 (シグナル0は送信しない)
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

/** PIDファイル削除 */
function cleanPidFile() {
  if (existsSync(CONFIG.pidFile)) {
    unlinkSync(CONFIG.pidFile);
    log("PID ファイルを削除しました");
  }
}

// ─── メイン処理 ───────────────────────────────────────────────────────────────

async function main() {
  console.log(chalk.bold("\n🔐 Aurora SSM トンネル起動スクリプト\n"));

  // ─ 入力検証
  const missing = [];
  if (!CONFIG.instanceId) missing.push("--instance (または BASTION_INSTANCE_ID)");
  if (!CONFIG.dbHost)     missing.push("--host     (または DB_HOST)");
  if (missing.length) {
    err("必須パラメータが未設定です:\n  " + missing.join("\n  "));
    process.exit(1);
  }

  // ─ 事前チェック
  await checkDependencies();
  await checkAwsAuth();
  await checkInstance();

  if (await isPortInUse(CONFIG.localPort)) {
    err(`ローカルポート ${CONFIG.localPort} は既に使用中です。--local-port で別のポートを指定してください。`);
    process.exit(1);
  }

  writePidFile();

  // ─ 接続情報の表示
  console.log(chalk.bold("\n📋 接続情報"));
  console.log(`  AWS Profile  : ${chalk.white(CONFIG.profile)}`);
  console.log(`  Region       : ${chalk.white(CONFIG.region)}`);
  console.log(`  Bastion EC2  : ${chalk.white(CONFIG.instanceId)}`);
  console.log(`  Aurora Host  : ${chalk.white(CONFIG.dbHost)}:${CONFIG.dbPort}`);
  console.log(`  Local Port   : ${chalk.white(CONFIG.localPort)}`);
  console.log(`\n  psql 接続例:`);
  console.log(chalk.green(`  psql -h 127.0.0.1 -p ${CONFIG.localPort} -U <DB_USER> -d <DB_NAME>\n`));

  // ─ SSMポートフォワーディング開始
  log("SSM セッションを開始します...");

  /**
   * aws ssm start-session でリモートホストへのポートフォワーディングを行う。
   * --target       : 踏み台EC2のインスタンスID
   * --document-name: AWS-StartPortForwardingSessionToRemoteHost (VPC内DBへの中継)
   * --parameters   : { host, portNumber, localPortNumber }
   */
  const ssmProcess = $`aws ssm start-session \
    --target ${CONFIG.instanceId} \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters host=${CONFIG.dbHost},portNumber=${String(CONFIG.dbPort)},localPortNumber=${String(CONFIG.localPort)} \
    --profile ${CONFIG.profile} \
    --region ${CONFIG.region}`.nothrow();

  // SSMプロセスの stdout をリアルタイムで流す
  ssmProcess.stdout.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) log(line);
  });
  ssmProcess.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line) warn(line);
  });

  // ─ クリーンアップ関数
  let cleanupDone = false;
  async function cleanup(signal) {
    if (cleanupDone) return;
    cleanupDone = true;

    console.log(chalk.bold(`\n\n🛑 シグナル受信 (${signal}) — クリーンアップ中...\n`));

    // SSMプロセスを終了
    try {
      ssmProcess.kill("SIGTERM");
      log("SSM プロセスに SIGTERM を送信しました");

      // 最大3秒待ってから強制終了
      await Promise.race([
        ssmProcess,
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
      ]).catch(async () => {
        warn("タイムアウト — SIGKILL で強制終了します");
        ssmProcess.kill("SIGKILL");
      });
    } catch (e) {
      // プロセスが既に終了している場合は無視
    }

    // SSMセッションをAPIから終了 (念のため)
    try {
      log("SSM セッション一覧を確認し、残存セッションをクリーンアップ中...");
      const listRes = await $`aws ssm describe-sessions \
        --state Active \
        --filter key=Target,value=${CONFIG.instanceId} \
        --query "Sessions[*].SessionId" \
        --output text \
        --profile ${CONFIG.profile} \
        --region ${CONFIG.region}`.quiet().nothrow();

      const sessionIds = listRes.stdout.trim().split(/\s+/).filter(Boolean);
      if (sessionIds.length > 0) {
        for (const sessionId of sessionIds) {
          await $`aws ssm terminate-session \
            --session-id ${sessionId} \
            --profile ${CONFIG.profile} \
            --region ${CONFIG.region}`.quiet().nothrow();
          ok(`セッション終了: ${sessionId}`);
        }
      } else {
        log("アクティブな SSM セッションなし (既に終了済み)");
      }
    } catch (e) {
      warn(`SSM セッションクリーンアップ中にエラー: ${e.message}`);
    }

    cleanPidFile();
    ok("クリーンアップ完了\n");
    process.exit(0);
  }

  // ─ シグナルハンドラー登録
  process.on("SIGINT",  () => cleanup("SIGINT"));   // Ctrl+C
  process.on("SIGTERM", () => cleanup("SIGTERM"));  // kill コマンド
  process.on("SIGHUP",  () => cleanup("SIGHUP"));   // ターミナル切断

  // ─ SSMプロセスが予期せず終了した場合の処理
  ssmProcess.then(() => {
    if (!cleanupDone) {
      warn("SSM プロセスが予期せず終了しました");
      cleanup("PROCESS_EXIT");
    }
  }).catch((e) => {
    if (!cleanupDone) {
      err("SSM プロセスがエラーで終了しました", e);
      cleanup("PROCESS_ERROR");
    }
  });

  ok("トンネル確立完了 — Ctrl+C で終了\n");

  // プロセスを生かし続ける (SSMプロセスが動いている間)
  await ssmProcess;
}

main().catch((e) => {
  err("予期しないエラー:", e);
  cleanPidFile();
  process.exit(1);
});
