define([
	"sugar-web/graphics/palette",
	"text!activity/palettes/settingspalette.html",
], function (palette, template) {
	var settingspalette = {};
	settingspalette.SettingsPalette = function (invoker, primaryText) {
		palette.Palette.call(this, invoker, primaryText);
		this.getPalette().id = "settings-palette";
		var containerElem = document.createElement("div");
		containerElem.innerHTML = template;
		this.setContent([containerElem]);

		// Add event listeners for mode buttons
		var self = this;
		setTimeout(function () {
			var paintButton = self.getPalette().querySelector("#paint-button");
			var learnButton = self.getPalette().querySelector("#learn-button");
			var tourButton = self.getPalette().querySelector("#tour-button");
			var doctorButton = self.getPalette().querySelector("#doctor-button");

			if (paintButton) {
				paintButton.addEventListener("click", function () {
					document.dispatchEvent(new CustomEvent('mode-selected', 
						{ detail: { mode: 0 } }
					));
					self.popDown();
				});
			}

			// if (learnButton) {
			// 	learnButton.addEventListener("click", function () {
			// 		document.dispatchEvent(new CustomEvent('mode-selected', 
			// 			{ detail: { mode: 1 } }
			// 		));
			// 		self.popDown();
			// 	});
			// }

			if (tourButton) {
				tourButton.addEventListener("click", function () {
					document.dispatchEvent(new CustomEvent('mode-selected', 
						{ detail: { mode: 2 } }
					));
					self.popDown();
				});
			}

			if (doctorButton) {
				doctorButton.addEventListener("click", function () {
					document.dispatchEvent(new CustomEvent('mode-selected', 
						{ detail: { mode: 3 } }
					));
					self.popDown();
				});
			}
		}, 100);
	};

	var addEventListener = function (type, listener, useCapture) {
		return this.getPalette().addEventListener(type, listener, useCapture);
	};

	settingspalette.SettingsPalette.prototype = Object.create(
		palette.Palette.prototype,
		{
			addEventListener: {
				value: addEventListener,
				enumerable: true,
				configurable: true,
				writable: true,
			},
		}
	);

	return settingspalette;
});
