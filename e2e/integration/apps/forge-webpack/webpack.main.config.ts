import { DatadogWebpackPlugin } from '@datadog/electron-sdk/webpack-plugin';

const bundledMode = process.env.DD_ELECTRON_BUNDLED_MODE === 'true';
const copyRuntimeDependencies = process.env.DD_ELECTRON_COPY_RUNTIME_DEPENDENCIES === 'true';

export const mainConfig = {
  entry: './src/main.ts',
  plugins: [new DatadogWebpackPlugin(bundledMode ? { bundledMode: true } : { copyRuntimeDependencies })],
  module: {
    rules: [
      {
        test: /native_modules[/\\].+\.node$/,
        use: 'node-loader',
      },
      {
        test: /[/\\]node_modules[/\\].+\.(m?js|node)$/,
        parser: { amd: false },
        use: {
          loader: '@vercel/webpack-asset-relocator-loader',
          options: {
            outputAssetBase: 'native_modules',
          },
        },
      },
      {
        test: /\.tsx?$/,
        exclude: /(node_modules|\.webpack)/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
          },
        },
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css', '.json'],
  },
};
