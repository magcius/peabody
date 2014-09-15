(function(wl) {
    "use strict";

    function ShadowPool(compositor, fd) {
        this._compositor = compositor;
        this._fd = fd;
        this._currentOffset = -1;
        this._setupSocket();

        this._currentToken = 0;
        this._operations = {};
    }
    ShadowPool.prototype.setSize = function(size) {
        this._size = size;
        this._buffer = new ArrayBuffer(this._size);
    };
    ShadowPool.prototype._setupSocket = function() {
        this._socket = this._compositor.newSocket("/fd/" + this._fd);

        this._socket.onmessage = function(event) {
            var data = event.data;
            if (data.byteLength) {
                var view = new Uint8Array(this._buffer);
                view.set(data, this._currentOffset);
            } else {
                var op = JSON.parse(data);
                if (op.type == 'update')
                    this._currentOffset = op.offset;
                else if (op.type == 'update_done')
                    this._updateDone(op.token);
            }
        };
    };
    ShadowPool.prototype.fetchUpdate = function(offset, w, h, stride) {
        var token = ++this._currentToken;
        this._socket.send("region " + [token, offset, w, h, stride].join(","));
        var promise = new Promise(function(resolve, reject) {
            this._operations[token] = resolve;
        });
        return promise;
    };
    ShadowPool.prototype._updateDone = function(token) {
        var resolve = this._operations[token];
        delete this._operations[token];
        resolve(this._buffer);
    };

    function Buffer(pool, offset, width, height, stride, format) {
        this._pool = pool;
        this._offset = offset;
        this._width = width;
        this._height = height;
        this._stride = stride;
        this._format = format;
        // XXX: Support more formats
        this._bytesPerPixel = 4;

        this._canvas = document.createElement('canvas');
        this._canvas.width = this._width;
        this._canvas.height = this._height;
        this._ctx = this._canvas.getContext('2d');
    }
    Buffer.prototype.damaged = function(x, y, w, h) {
        var poolOffset = this._offset + (y * this._stride) + (x * this._bytesPerPixel);
        var bytesW = w * this._bytesPerPixel;
        var bytesH = h * this._bytesPerPixel;

        this._pool.fetchUpdate(poolOffset, bytesW, bytesH, this._stride).then(function(buffer) {
            var imageData = this._ctx.getImageData(x, y, w, h);

            for (var bufferY = 0; bufferY < h; bufferY++) {
                var bufferOffs = poolOffset + (bufferY * this._stride);
                var imageOffs = bufferY * w;
                imageData.data.set(buffer.slice(bufferOffs, bufferOffs + this._stride), imageOffs);
            }

            this._ctx.setImageData(x, y, w, h, imageData);
        }.bind(this));
    };
    Buffer.prototype.getImage = function() {
        return this._canvas;
    };

    function initSHM(compositor) {
        function bindSHM(shmResource) {
            function create_pool(newID, fd, size) {
                var poolResource = new wl.wl_shm_pool(this.client, newID, this.version);
                var pool = new ShadowPool(compositor, fd);

                function create_buffer(newID, offset, width, height, stride, format) {
                    var bufferResource = new wl.wl_shm_buffer(this.client, newID, this.version);
                }

                function destroy() {
                    this.destroy();
                }

                function resize(newSize) {
                    pool.setSize(newSize);
                }

                poolResource.setImplementation({
                    create_buffer: create_buffer,
                    destroy: destroy,
                    resize: resize,
                });

                pool.setSize(size);
            }

            shmResource.setImplementation({
                create_pool: create_pool,
            });

            shmResource.format(wl.WL_SHM_FORMAT.ARGB8888);
            shmResource.format(wl.WL_SHM_FORMAT.XRGB8888);
        }

        compositor.display.registerGlobal(wl.wl_shm, 1, bindSHM);
    }

    wl.initSHM = initSHM;

})(wl);
