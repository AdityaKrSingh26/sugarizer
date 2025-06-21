define([
	"sugar-web/graphics/palette",
	"text!activity/palettes/modelpalette.html",
], function (palette, template) {
	var modelpalette = {};

	modelpalette.ModelPalette = function (invoker, primaryText) {
		palette.Palette.call(this, invoker, primaryText);
		this.getPalette().id = "model-palette";

		var containerElem = document.createElement("div");
		containerElem.innerHTML = template;

		this.setContent([containerElem]);

		// Add event listeners for model buttons after content is set
		this.setupModelButtons();
	};

	// Setup event listeners for model buttons
	modelpalette.ModelPalette.prototype.setupModelButtons = function () {
		var self = this;

		// Use setTimeout to ensure DOM elements are ready
		setTimeout(function () {
			var skeletonButton = document.getElementById('model-skeleton-button');
			var bodyButton = document.getElementById('model-body-button');
			var organsButton = document.getElementById('model-organs-button');

			var buttons = [skeletonButton, bodyButton, organsButton];

			function setActiveButton(activeButton) {
				buttons.forEach(function (btn) {
					if (btn) btn.classList.remove('active');
				});
				if (activeButton) activeButton.classList.add('active');
			}

			// Store reference to setActiveButton for external access
			self.setActiveButton = setActiveButton;
			self.buttons = {
				skeleton: skeletonButton,
				body: bodyButton,
				organs: organsButton
			};

			if (skeletonButton) {
				skeletonButton.addEventListener('click', function () {
					setActiveButton(skeletonButton);
					self.fireEvent('model-selected', { model: 'skeleton' });
					self.popDown();
				});
			}

			if (bodyButton) {
				bodyButton.addEventListener('click', function () {
					setActiveButton(bodyButton);
					self.fireEvent('model-selected', { model: 'body' });
					self.popDown();
				});
			}

			if (organsButton) {
				organsButton.addEventListener('click', function () {
					setActiveButton(organsButton);
					self.fireEvent('model-selected', { model: 'organs' });
					self.popDown();
				});
			}
		}, 100);
	};

	// update the active button based on current model
	modelpalette.ModelPalette.prototype.updateActiveModel = function (modelName) {
		if (this.setActiveButton && this.buttons && this.buttons[modelName]) {
			this.setActiveButton(this.buttons[modelName]);
		}
	};

	// Fire custom events
	modelpalette.ModelPalette.prototype.fireEvent = function (eventName, data) {
		var event = new CustomEvent(eventName, {
			detail: data,
			bubbles: true,
			cancelable: true
		});

		this.getPalette().dispatchEvent(event);

		// Also dispatch on document for global listening
		document.dispatchEvent(event);
	};

	var addEventListener = function (type, listener, useCapture) {
		return this.getPalette().addEventListener(type, listener, useCapture);
	};

	modelpalette.ModelPalette.prototype = Object.create(
		palette.Palette.prototype,
		{
			addEventListener: {
				value: addEventListener,
				enumerable: true,
				configurable: true,
				writable: true,
			},
			setupModelButtons: {
				value: modelpalette.ModelPalette.prototype.setupModelButtons,
				enumerable: true,
				configurable: true,
				writable: true,
			},
			updateActiveModel: {
				value: modelpalette.ModelPalette.prototype.updateActiveModel,
				enumerable: true,
				configurable: true,
				writable: true,
			},
			fireEvent: {
				value: modelpalette.ModelPalette.prototype.fireEvent,
				enumerable: true,
				configurable: true,
				writable: true,
			},
		}
	);

	return modelpalette;
});