const nodeExternals = require('webpack-node-externals');
const path = require('path');

module.exports = {
    entry: './src/Index.ts',
    mode: 'production',
    output: {
        path: path.resolve(__dirname + '/../dist/es5-minified/'),
        filename: 'change-checker.minified.js',
        library: 'change-checker',
        libraryTarget: 'umd',
        devtoolModuleFilenameTemplate: info => {
            var $filename = 'sources://change-checker/' + info.resourcePath;
            return $filename;
        }
    },
    resolve: {
        extensions: [".ts", ".js"]
    },
    devtool: 'source-map',
    externals: [nodeExternals()],
    module: {
        rules: [
            {
                test: /\.ts/,
                exclude: /node_modules/,
                loader: "ts-loader",
                options: { configFile: "../tsconfig.es5.webpack.json" }
            }
        ]
    }
};
