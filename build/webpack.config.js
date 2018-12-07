const nodeExternals = require('webpack-node-externals');
const path = require('path');
const ForkTsCheckerWebpackPlugin = require('fork-ts-checker-webpack-plugin');

module.exports = {
    entry: './src/Index.ts',
    mode: 'production',
    optimization: {
        // minimize: false,
        // removeEmptyChunks: false,
        // removeAvailableModules: false,
        // mergeDuplicateChunks: false,
        // flagIncludedChunks: false
	},
    output: {
        path: path.resolve(__dirname + '/../dist/'),
        filename: 'index.js',
        library: 'change-checker',
        libraryTarget: 'commonjs2',
        devtoolModuleFilenameTemplate: info => {
            var $filename = 'sources://change-checker/' + info.resourcePath;
            return $filename;
        }
    },
    resolve: {
        extensions: [".ts", ".js"]
    },
    devtool: 'source-map',
    performance: {
        maxEntrypointSize: 1048576,
        maxAssetSize: 1048576
    },
    externals: [nodeExternals()],
    module: {
        rules: [
            {
                test: /\.ts/,
                exclude: /node_modules/,
                loader: "ts-loader",
                options: {
                    // disable type checker - we will use it in fork plugin
                    transpileOnly: true
                }
            },
        ]
    },
    plugins: [      
        new ForkTsCheckerWebpackPlugin({            
            tslint: './tslint.json',
            workers: ForkTsCheckerWebpackPlugin.ONE_CPU
        })
    ],
    node: {
        // prevent webpack from injecting useless setImmediate polyfill because Vue
        // source contains it (although only uses it if it's native).
        // setImmediate: false,
        // prevent webpack from injecting mocks to Node native modules
        // that does not make sense for the client
        // dgram: 'empty',
        // fs: 'empty',
        // net: 'empty',
        // tls: 'empty',
        // child_process: 'empty'
    }
};
