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
        }
    );

    return modelpalette;
});