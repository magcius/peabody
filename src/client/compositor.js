(function(wl) {
    "use strict";

    function initCompositor(compositor) {
        function bindCompositor(compositorResource) {
            function create_surface(newID) {
                wl.createSurface(newID);
            }

            function create_region(newID) {
                var regionResource = new wl.wayland.wl_region(client, newID);
                var region = new Region();

                function destroy() {
                    this.destroy();
                }

                function add(x, y, w, h) {
                    region.union_rect(region, x, y, w, h);
                }

                function subtract(x, y, w, h) {
                    // Does anybody actually use this?
                }

                regionResource.setVersion(this.version);
                regionResource.setImplementation({
                    destroy: destroy,
                    add: add,
                    subtract: subtract,
                });
            }

            compositorResource.setImplementation({
                create_surface: create_surface,
                create_region: create_region,
            });
        }

        compositor.display.registerGlobal(wl.wayland.wl_compositor, 1, bindCompositor);
    }

    wl.initCompositor = initCompositor;

})(wl);
