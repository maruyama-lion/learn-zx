import { $, argv, question } from 'zx';

async function lambdaUpdate() {
/**
 * 1. 準備
 */
	console.log('Lambda関数の更新を開始します...');

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

/**
 * 2. CfnOutputから情報を取得
 */
// TODO: CfnOutputから必要な情報を取得するロジックをここに追加します。
console.log('CfnOutputから必要な情報を取得しています...');

console.log('CfnOutputからの情報の取得が完了しました。');

/**
 * 3. DockerイメージのビルドとECRへのプッシュ
 */
// TODO: DockerイメージのビルドとECRへのプッシュを行うロジックをここに追加します。(ECRのリポジトリURLを使用する)
console.log('DockerイメージのビルドとECRへのプッシュを開始します...');

console.log('DockerイメージのビルドとECRへのプッシュが完了しました。');

/**
 * 4. Lambda関数の更新
 */
// TODO: update-function-code コマンドを実行してLambda関数を更新するロジックをここに追加します。(ECRのイメージを使用する)
console.log('Lambda関数を更新しています...');

console.log('Lambda関数の更新が完了しました。');
}

lambdaUpdate();
