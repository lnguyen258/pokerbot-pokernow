const {resolve} = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const CopyPlugin = require("copy-webpack-plugin");

/**
 * Sites the bot runs on: sites.json, plus any `--env site=<url>` given to the build.
 * Written into the manifest (content_scripts.matches and host_permissions).
 */
function sitePatterns(env) {
    const toPattern = s => /\*/.test(s) ? s : s.replace(/\/+$/, "") + "/*";     // "https://x.com" -> "https://x.com/*"
    const fromFile = require("./sites.json").sites.filter(s => !/YOUR-SITE/i.test(s));
    const fromEnv = [].concat(env.site ?? []).flatMap(s => String(s).split(","));
    const sites = [...new Set([...fromFile, ...fromEnv].map(s => toPattern(s.trim())).filter(Boolean))];
    if (!sites.length) throw new Error("sites.json has no sites: add at least one");
    console.log("[build] bot runs on: " + sites.join(", "));
    return sites;
}

module.exports = (env = {}) => ({
    mode: "development",
    // devtool: 'cheap-module-source-map',
    devtool: 'source-map',
    entry: {
        popup: './src/pages/popup.ts',
        main: './src/main.ts',
    },
    module: {
        rules: [{
            test: /\.ts(x?)$/,
            exclude: /node_modules/,
            use: 'ts-loader',
        }],
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js'],
    },
    output: {
        filename: '[name].js',
        path: resolve(__dirname, 'dist'),
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: "src/pages/popup.html",
            filename: "popup.html",
            chunks: ["popup"],
        }),
        new CopyPlugin({
            patterns: [{
                from: "public",
                to: ".",
                transform(content, path) {
                    if (!path.endsWith("manifest.json")) return content;
                    const manifest = JSON.parse(content.toString());
                    const sites = sitePatterns(env);
                    manifest.content_scripts[0].matches = sites;
                    manifest.host_permissions = sites;
                    return JSON.stringify(manifest, null, 2);
                },
            }],
        }),
        new CleanWebpackPlugin(),
    ],
});
