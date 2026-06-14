import { $, argv, question } from 'zx';

async function loadArg() {
  const env = argv.env;
  const region = argv.region;

  if (!env || !region) {
    console.error('引数がありません。 --env and --region arguments.');
    process.exit(1);
  }

  if (env === 'dev') {
    const confirmation = await question(`⚠️ ${env}環境へのデプロイです。本当に続行しますか？`);
    if (confirmation !== 'y') {
      console.log('デプロイをキャンセルしました。');
      process.exit(0);
    }
  } else {
    console.error(`🚨 ${env}環境はサポートされていません。`);
    process.exit(1);
  }

  console.log(`Loading environment: ${env}, region: ${region}`);
  // You can add your logic here to load the environment variables or configurations based on the provided arguments.
}

loadArg();
