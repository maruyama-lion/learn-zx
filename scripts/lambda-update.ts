import { $, argv, question } from 'zx';

async function lambdaUpdate() {
  console.log('Lambda関数の更新を開始します...');

  const env = argv.env;
  const region = argv.region;

  if (!env || !region) {
    console.error('引数がありません。 --env, --region を指定してください。');
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

  console.log('CloudFormation Exportから必要な情報を取得しています...');

  const exportsRaw = await $`aws cloudformation list-exports --region ${region} --output json`;
  const exports = JSON.parse(exportsRaw.stdout) as {
    Exports?: Array<{ Name?: string; Value?: string }>;
  };
  const exportMap = (exports.Exports ?? []).reduce<Record<string, string>>((acc, item) => {
    if (item.Name && item.Value) {
      acc[item.Name] = item.Value;
    }
    return acc;
  }, {});

  const lambdaFunctionName = exportMap['LambdaFunctionName']?.trim() ?? '';
  const ecrRepositoryName = exportMap['ECRRepositoryName']?.trim() ?? '';

  if (!lambdaFunctionName || lambdaFunctionName === 'None') {
    console.error('LambdaFunctionName を CloudFormation Export から取得できませんでした。');
    process.exit(1);
  }

  if (!ecrRepositoryName || ecrRepositoryName === 'None') {
    console.error('ECRRepositoryName を CloudFormation Export から取得できませんでした。');
    process.exit(1);
  }

  const gitCommitHash = (await $`git rev-parse --short HEAD`).stdout.trim();
  const repositoryUri = (
    await $`aws ecr describe-repositories --repository-names ${ecrRepositoryName} --region ${region} --query "repositories[0].repositoryUri" --output text`
  ).stdout.trim();
  const commitImageUri = `${repositoryUri}:${gitCommitHash}`;
  const latestImageUri = `${repositoryUri}:latest`;

  console.log(`Lambda function: ${lambdaFunctionName}`);
  console.log(`ECR repository: ${ecrRepositoryName}`);
  console.log(`Image URI: ${commitImageUri}`);

  console.log('DockerイメージのビルドとECRへのプッシュを開始します...');

  const registry = repositoryUri.split('/')[0];
  await $`aws ecr get-login-password --region ${region} | docker login --username AWS --password-stdin ${registry}`;
  await $`docker build -t ${commitImageUri} -t ${latestImageUri} .`;
  await $`docker push ${commitImageUri}`;
  await $`docker push ${latestImageUri}`;
  await $`docker rmi ${commitImageUri} ${latestImageUri}`;

  console.log('DockerイメージのビルドとECRへのプッシュが完了しました。');

  console.log('Lambda関数を更新しています...');

  await $`aws lambda update-function-code --function-name ${lambdaFunctionName} --image-uri ${commitImageUri} --region ${region}`;

  console.log('Lambda関数の更新が完了しました。');
}

lambdaUpdate();
