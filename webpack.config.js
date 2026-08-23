const webpack = require("@nativescript/webpack");
const { resolve } = require("path");
const { Compilation, DefinePlugin, IgnorePlugin, sources } = require("webpack");

class StripWorkspacePathsPlugin {
	apply(compiler) {
		compiler.hooks.thisCompilation.tap("StripWorkspacePathsPlugin", (compilation) => {
			compilation.hooks.processAssets.tap(
				{ name: "StripWorkspacePathsPlugin", stage: Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE },
				(assets) => {
					const workspace = resolve(__dirname);
					for (const name of Object.keys(assets).filter((asset) => asset.endsWith(".mjs"))) {
						const content = assets[name].source().toString().split(workspace).join(".");
						compilation.updateAsset(name, new sources.RawSource(content));
					}
				},
			);
		});
	}
}

module.exports = (env) => {
	webpack.init(env);
	const production = env?.production === true || env?.production === "true";

	// Learn how to customize:
	// https://docs.nativescript.org/webpack

	// Bundle the top-level project docs so the Settings app's About section
	// can display them (see app/ui/dashboard/settings-menus.ts).
	for (const doc of ["README.md", "LICENSE", "PRIVACY", "ACKNOWLEDGEMENTS.md"]) {
		webpack.Utils.addCopyRule({
			from: resolve(__dirname, doc),
			to: "about/",
		});
	}

	const config = webpack.resolveConfig();
	config.plugins.push(new DefinePlugin({
		__HERMES_DEBUG_CONTROL__: JSON.stringify(!production),
	}));
	if (production) {
		config.plugins.push(new IgnorePlugin({
			resourceRegExp: /^\.\.\/\.\.\/debug-control\/control-runtime$/,
		}));
	}
	// Release artifacts must not embed local absolute paths through source maps.
	config.devtool = false;
	config.plugins.push(new StripWorkspacePathsPlugin());
	return config;
};
