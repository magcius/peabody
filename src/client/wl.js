(function(wl) {
    "use strict";

    var MAX_UINT32 = 0xFFFFFFFF;

    function Display() {
        this._serial = 0;

        this.$globals = [];
    }
    Display.prototype.nextSerial = function() {
        if (this._serial == MAX_UINT32)
            this._serial = 0;
        this._serial++;
        return this._serial;
    };
    Display.prototype.registerGlobal = function(constructor, version, bindFunc) {
        var global = {
            constructor: constructor,
            version: version,
            bindFunc: bindFunc
        };

        this.$globals.push(global);
    };
    wl.Display = Display;

    function setupSocketReader(socket, client) {
        var messageBuffer = [];
        var pos = 0;

        function processMessage() {
            var littleEndian = true;

            var currentMessage = messageBuffer[0];
            if (!currentMessage)
                return false;

            var leftInCurrentMessage = currentMessage.byteLength - pos;
            var view = new DataView(currentMessage);

            var size = view.getUint16(pos + 6, littleEndian);

            if (leftInCurrentMessage < size)
                throw new Error("XXX: This shouldn't happen\n");

            var buffer = currentMessage.slice(pos, pos + size);
            pos += size;

            if (pos == currentMessage.byteLength) {
                messageBuffer.shift();
                pos = 0;
            }

            client.$handleRequest(buffer, fds);
            return true;
        }

        function processMessages() {
            while (processMessage())
                ;
        }

        var mode;
        var fds = [];

        socket.onmessage = function(event) {
            // Mode-set messages to tell us what the next message is;
            // they're simply text.
            if (event.data === "wl") {
                mode = "wl";
            } else if (event.data === "fd") {
                mode = "fd";
            } else {
                // Actual messages

                if (mode == "fd") {
                    // FDs from the client for the next request
                    var view = new Int32Array(event.data);
                    for (var i = 0; i < view.length; i++)
                        fds.push(view[i]);
                } else if (mode == "wl") {
                    // Wayland request
                    messageBuffer.push(event.data);
                    try {
                        processMessages();
                    } catch(e) {
                        // deregister
                        socket.onmessage = null;
                        throw e;
                    }
                }
            }
        };
    }

    function Client(display, socket) {
        this.display = display;
        this._socket = socket;

        this._objectMap = new Map();

        this._bindDisplay();

        setupSocketReader(this._socket, this);
        this._socket.onclose = function() {
            this._close();
        }.bind(this);
    }
    Client.prototype._close = function() {
        this._socket.close();

        this._closed = true;
        this._objectMap.forEach(function(resource) {
            resource.destroy();
        });
    };

    Client.prototype._bindDisplay = function() {
        var client = this;
        var display = client.display;

        function sync(callback) {
            callback.setVersion(this.version);
            callback.done(display.nextSerial());
        }

        function get_registry(registry) {
            function findGlobal(name) {
                var idx = name - 1;
                return display.$globals[idx];
            }

            function globalName(idx) {
                var name = idx + 1;
                return name;
            }

            function bind(name, interfaceName, version, id) {
                var global = findGlobal(name);
                var resource = new global.constructor(client, id);
                resource.setVersion(version);
                global.bindFunc(resource);
            }

            registry.setVersion(1);
            registry.setImplementation({
                bind: bind,
            });

            display.$globals.forEach(function(global, i) {
                var name = globalName(i);
                var iface = global.constructor.$iface;
                registry.global(name, iface.name, global.version);
            });
        }

        // Bootstrap the global display.
        this.displayResource = new wl.wl_display(client, 1);
        this.displayResource.setVersion(1);
        this.displayResource.setImplementation({
            sync: sync,
            get_registry: get_registry,
        });
    };

    Client.prototype.$registerObject = function(obj) {
        this._objectMap.set(obj.$objectID, obj);
    };
    Client.prototype.getObject = function(objectID) {
        return this._objectMap.get(objectID);
    };
    Client.prototype.$handleRequest = function(buffer, fds) {
        var littleEndian = true;

        var view = new DataView(buffer);

        var objectID = view.getUint32(0, littleEndian);
        var opcode = view.getUint16(4, littleEndian);
        var size = view.getUint16(6, littleEndian);

        var pos = 8;
        function readInt() {
            var val = view.getInt32(pos, littleEndian);
            pos += 4;
            return val;
        }
        function readUint() {
            var val = view.getUint32(pos, littleEndian);
            pos += 4;
            return val;
        }
        function readFixed() {
            var val = view.getInt32(pos, littleEndian);
            pos += 4;
            return val / 0x100;
        }
        function readString() {
            var length = view.getUint32(pos, littleEndian);
            pos += 4;
            var string = '';
            for (var i = 0; i < length - 1; i++)
                string += String.fromCharCode(view.getUint8(pos++));
            if (view.getUint8(pos++) != 0)
                throw new Error("bad null byte");
            // align to 32-bit boundary
            pos += 4 - (length % 4);
            return string;
        }
        function readObject(type, nullable) {
            var val = view.getUint32(pos, littleEndian);
            pos += 4;
            var obj = display.getObject(val);
            if (!nullable && obj == null)
                throw new Error("Got a bad object");
            if (obj && obj.$iface.name != type)
                throw new Error("Got a bad object");
        }
        function readNewID(type) {
            var val = view.getUint32(pos, littleEndian);
            pos += 4;

            if (type.length > 0) {
                var constructor = wl[type];
                if (!constructor)
                    throw new Error("Illegal type " + type);
                return new constructor(client, val);
            } else {
                return val;
            }
        }
        function readArray() {
            var size = view.getUint32(pos, littleEndian);
            pos += 4;

            var view = buffer.slice(pos, pos + size);
            pos += view.byteLength;

            // align to 32-bit boundary
            pos += 4 - (length % 4);
            return view;
        }
        function readFD() {
            return fds.shift();
        }

        var obj = this.getObject(objectID);
        if (!obj)
            throw new Error("No object by ID " + objectID);
        var iface = obj.constructor.$iface;
        var request = iface.requests[opcode];
        var types = request[1];

        var args = [];

        function readArg(type) {
            var nullable = false;
            if (type[0] == '?') {
                nullable = true;
                type = type.slice(1);
            }

            switch (type[0]) {
	    case 'i': return readInt();
	    case 'u': return readUint()
	    case 'f': return readFixed();
	    case 's': return readString();
	    case 'o': return readObject(type.slice(1), nullable);
	    case 'n': return readNewID(type.slice(1));
	    case 'a': return readArray();
	    case 'h': return readFD();
            }
        }

        args = args.map(readArg);

        if (pos != size)
            throw new Error("Size mismatch");

        obj.$handleRequest(opcode, args);
    };

    // XXX: Be smarter about buffer management, here.
    var tmpBuffer = new ArrayBuffer(0xFFFF);

    Client.prototype.$sendEvent = function(objectID, opcode, types, args) {
        if (this._closed)
            return;

        var littleEndian = true;

        var buffer = tmpBuffer;
        var view = new DataView(buffer);

        view.setUint32(0, objectID, littleEndian);
        view.setUint16(4, opcode, littleEndian);

        var pos = 8;
        function writeInt(arg) {
            view.setInt32(pos, arg, littleEndian);
            pos += 4;
        }
        function writeUint(arg) {
            view.setUint32(pos, arg, littleEndian);
            pos += 4;
        }
        function writeFixed(arg) {
            view.setInt32(pos, arg * 0x100, littleEndian);
            pos += 4;
        }
        function writeString(arg) {
            var length = arg.length + 1;
            view.setUint32(pos, length, littleEndian);
            pos += 4;

            for (var i = 0; i < length - 1; i++)
                view.setUint8(pos++, arg.charCodeAt(i));
            view.setUint8(pos++, 0);
            // align to 32-bit boundary
            pos += 4 - (length % 4);
        }
        function writeObject(type, obj, nullable) {
            var arg;
            if (obj) {
                if (obj.$iface.name != type)
                    throw new Error("Bad object");
                arg = obj.$objectID;
            } else if (nullable)
                arg = 0;
            else
                throw new Error("Required object, got null");
            view.setUint32(pos, arg, littleEndian);
            pos += 4;
        }
        function writeNewID(type, arg) {
            view.setUint32(pos, arg, littleEndian);
            pos += 4;
        }
        function writeArray(arg) {
            buffer.setUint32(pos, arg.byteLength, littleEndian);
            pos += 4;

            var byteView = new Uint8Array(buffer);
            byteView.set(arg, pos);
            pos += arg.byteLength;

            // align to 32-bit boundary
            pos += 4 - (length % 4);
        }
        function writeFD(arg) {
            throw new Error("welp");
        }

        function writeArg(type) {
            var nullable = false;
            if (type[0] == '?') {
                nullable = true;
                type = type.slice(1);
            }

            var arg = args.shift();

            switch (op) {
	    case 'i': return writeInt(arg);
	    case 'u': return writeUint(arg)
	    case 'f': return writeFixed(arg);
	    case 's': return writeString(arg);
	    case 'o': return writeObject(type.slice(1), arg, nullable);
	    case 'n': return writeNewID(type.slice(1), arg);
	    case 'a': return writeArray(arg);
	    case 'h': return writeFD(arg);
            }
        }

        types.forEach(writeArg);

        var size = pos;

        view.setUint16(6, size, littleEndian);
        this._socket.send(buffer.slice(0, size));
    }
    wl.Client = Client;

    function Resource(client, objectID) {
        this.client = client;
        this.$objectID = objectID;
        this._destroyListeners = [];

        client.$registerObject(this);
    }
    Resource.prototype.setVersion = function(version) {
        this.version = version;
    };
    Resource.prototype.setImplementation = function(implementation) {
        this.$implementation = implementation;
    };
    Resource.prototype.addDestroyListener = function(func) {
        // Add new listeners to the front so the first destroy
        // listener is the one that's called last.
        this._destroyListeners.unshift(func);
    };
    Resource.prototype.destroy = function() {
        this.client.displayResource.delete_id(this.$objectID);
        this._destroyListeners.forEach(function(func) {
            func(this);
        });
    };
    Resource.prototype.$handleRequest = function(opcode, args) {
        var request = this.constructor.$iface.requests[opcode];
        var name = request[0];
        this.$implementation[name].apply(this, args);
    };

    Resource.create = function(iface) {
        var newResource = function(client, objectID) {
            Resource.call(this, client, objectID);
        };
        newResource.prototype = Object.create(Resource.prototype);
        newResource.prototype.constructor = newResource;
        newResource.$iface = iface;

        iface.events.forEach(function(event, i) {
            var opcode = i;
            var name = event[0];
            var types = event[1];
            newResource.prototype[name] = function() {
                var args = [].slice.call(arguments);
                this.client.$sendEvent(this.$objectID, opcode, types, args);
            };
        });
        return newResource;
    };
    wl.Resource = Resource;

})((window.wl = {}));
