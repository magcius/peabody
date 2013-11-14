(function(wl) {
    "use strict";

    var compositor = {};

    var display = new wl.Display();
    compositor.display = display;

    function newSocket(path) {
        var ws = new WebSocket("ws://localhost:8080" + path, "peabody");
        ws.binaryType = 'arraybuffer';
        return ws;
    }
    compositor.newSocket = newSocket;

    function newClient(path) {
        var ws = compositor.newSocket(path);
        return new wl.Client(display, ws);
    }

    var control = compositor.newSocket("/control/");
    control.onmessage = function(event) {
        var path = event.data;
        newClient(path);
    };

    wl.initSHM(compositor);
    wl.initCompositor(compositor);

})(wl);
