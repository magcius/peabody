
noinst_PROGRAMS =
noinst_LIBRARIES =
TESTS =

noinst_PROGRAMS += peabody-server

peabody_server_SOURCES = 			\
	src/server/peabody-server.c		\
	src/server/peabody-server.h		\
	src/server/main.c
peabody_server_CFLAGS = 			\
	$(GIO_CFLAGS)				\
	-Isrc/
peabody_server_LDADD = 				\
	$(GIO_LIBS)				\
	libwebsocket.a

include src/websocket/Makefile-websocket.am
