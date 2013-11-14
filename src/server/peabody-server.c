/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

/*
 * Copyright (C) 2014 Red Hat
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as
 * published by the Free Software Foundation; either version 2 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA
 * 02111-1307, USA.
 *
 * Written by:
 *     Jasper St. Pierre <jstpierre@mecheye.net>
 */

#include "peabody-server.h"

#include <gio/gio.h>
#include <gio/gunixsocketaddress.h>
#include <gio/gunixfdmessage.h>

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>

#include "websocket/websocket.h"

struct _PeabodyServer {
  WebSocketConnection *control_connection;

  GHashTable *clients;
  int client_id_count;
};

typedef struct {
  PeabodyServer *server;

  uint32_t client_id;
  GSocketConnection *wl_connection;
  uint32_t wl_connection_source;
  WebSocketConnection *ws_connection;
} WaylandClient;

static void
ws_open_control_connection (PeabodyServer       *server,
                            WebSocketConnection *connection)
{
  /* If we have an existing control connection, just close that
   * and assume a new WS client showed up. */
  if (server->control_connection)
    web_socket_connection_close (server->control_connection, 0, NULL);

  server->control_connection = connection;
}

static void
wayland_client_destroy (WaylandClient *client)
{
  PeabodyServer *server = client->server;

  g_source_remove (client->wl_connection_source);
  g_io_stream_close (G_IO_STREAM (client->wl_connection), NULL, NULL);
  g_object_unref (client->wl_connection);

  web_socket_connection_close (client->ws_connection, WEB_SOCKET_CLOSE_GOING_AWAY, NULL);
  g_object_unref (client->ws_connection);

  g_hash_table_remove (server->clients, &client->client_id);
  g_slice_free (WaylandClient, client);
}

static gboolean
wl_to_ws (GSocket      *socket,
          GIOCondition  condition,
          gpointer      user_data)
{
  WaylandClient *client = user_data;

  char buffer[0xFFFF];
  GInputVector iov = { &buffer, sizeof (buffer) };
  GSocketControlMessage **in_all_cmsg;
  GError *error = NULL;
  int flags = 0;
  int size;

  size = g_socket_receive_message (socket, NULL,
                                   &iov, 1,
                                   &in_all_cmsg, NULL,
                                   &flags, NULL, &error);
  if (size == -1)
    {
      g_printerr ("%s\n", error->message);
      g_assert (FALSE);
    }

  if (size == 0)
    {
      wayland_client_destroy (client);
      return FALSE;
    }

  if (in_all_cmsg && G_IS_UNIX_FD_MESSAGE (in_all_cmsg[0]))
    {
      GSocketControlMessage *cmsg = in_all_cmsg[0];

      int *fds, n_fd;
#define MAX_FDS_OUT	28
      char fd_buffer[sizeof(int32_t) * MAX_FDS_OUT];
      int32_t *b;
      size_t fd_size;

      /* Absorb all the FDs, and then pass the IDs to the browser. We'll
       * get requests later through the control socket to manipulate them. */
      fds = g_unix_fd_message_steal_fds (G_UNIX_FD_MESSAGE (cmsg), &n_fd);
      g_assert (n_fd <= MAX_FDS_OUT);

      b = (int32_t *) buffer;

      fd_size = sizeof(int32_t) * (n_fd);
      while (n_fd--)
        *b++ = *fds++;

      web_socket_connection_send (client->ws_connection, WEB_SOCKET_DATA_TEXT, NULL,
                                  g_bytes_new_static ("fd", 2));

      web_socket_connection_send (client->ws_connection, WEB_SOCKET_DATA_BINARY, NULL,
                                  g_bytes_new_static (fd_buffer, fd_size));
    }

  if (in_all_cmsg)
    {
      int i;
      for (i = 0; in_all_cmsg[i]; i++)
        g_object_unref (in_all_cmsg[i]);
    }

  web_socket_connection_send (client->ws_connection, WEB_SOCKET_DATA_TEXT, NULL,
                              g_bytes_new_static ("wl", 2));

  web_socket_connection_send (client->ws_connection, WEB_SOCKET_DATA_BINARY, NULL,
                              g_bytes_new_static (buffer, size));

  return G_SOURCE_CONTINUE;
}

static void
ws_to_wl (WebSocketConnection *connection,
          int                  opcode,
          GBytes              *message,
          gpointer             user_data)
{
  WaylandClient *client = user_data;
  GOutputStream *stream = g_io_stream_get_output_stream (G_IO_STREAM (client->wl_connection));

  g_output_stream_write_bytes (stream, message, NULL, NULL);
}

static void
ws_open_client_connection (PeabodyServer       *server,
                           WebSocketConnection *connection,
                           uint32_t             client_id)
{
  WaylandClient *client = g_hash_table_lookup (server->clients, &client_id);

  /* XXX -- close the connection */
  if (client == NULL)
    return;

  client->ws_connection = connection;

  /* wl to ws */
  {
    GSocket *socket = g_socket_connection_get_socket (client->wl_connection);
    GSource *source = g_socket_create_source (socket, G_IO_IN, NULL);
    client->wl_connection_source = g_source_attach (source, NULL);
    g_source_set_callback (source, (GSourceFunc) wl_to_ws, client, NULL);
  }

  /* ws to wl */
  {
    g_signal_connect (client->ws_connection, "message", G_CALLBACK (ws_to_wl), client);
  }
}

static void
fd_send_region (WebSocketConnection *connection,
                uint32_t fd, int token,
                int offset, int w, int h, int stride)
{
  char *region_str;
  char *row = g_malloc (w);

  for (int y = 0; y < h; y++)
    {
      int row_offset = offset + (y * stride);

      lseek (fd, row_offset, SEEK_SET);
      read (fd, &row, w);

      region_str = g_strdup_printf ("{ type: \"update\", offset: %d }", offset);
      web_socket_connection_send (connection, WEB_SOCKET_DATA_TEXT, NULL,
                                  g_bytes_new_take (region_str, strlen (region_str)));

      web_socket_connection_send (connection, WEB_SOCKET_DATA_BINARY, NULL,
                                  g_bytes_new_static (row, w));
    }

  g_free (row);

  region_str = g_strdup_printf ("{ type: \"update_done\", token: %d }", token);
  web_socket_connection_send (connection, WEB_SOCKET_DATA_TEXT, NULL,
                              g_bytes_new_take (region_str, strlen (region_str)));
}

static void
fd_message (WebSocketConnection *connection,
            int                  opcode,
            GBytes              *message,
            gpointer             user_data)
{
  uint32_t fd = GPOINTER_TO_UINT (user_data);

  /* Only text opcodes are allowed. */
  if (opcode != WEB_SOCKET_DATA_TEXT)
    return;

  const char *data = g_bytes_get_data (message, NULL);
  if (g_str_has_prefix (data, "region "))
    {
      int token, offset, w, h, stride;
      sscanf (data, "region %d,%d,%d,%d,%d", &token, &offset, &w, &h, &stride);
      fd_send_region (connection, fd, token, offset, w, h, stride);
    }
}

static void
fd_close (WebSocketConnection *connection,
          gpointer             user_data)
{
  uint32_t fd = GPOINTER_TO_UINT (user_data);

  close (fd);
}

static void
ws_open_fd_connection (PeabodyServer       *server,
                       WebSocketConnection *connection,
                       uint32_t             fd)
{
  g_signal_connect (connection, "message", G_CALLBACK (fd_message), GUINT_TO_POINTER (fd));
  g_signal_connect (connection, "close", G_CALLBACK (fd_close), GUINT_TO_POINTER (fd));
}

static void
ws_on_connection_open (WebSocketConnection *connection,
                       gpointer user_data)
{
  PeabodyServer *server = user_data;
  const char *resource = web_socket_server_get_resource (WEB_SOCKET_SERVER (connection));

  /* Do routing */
  if (g_str_has_prefix (resource, "/control/"))
    {
      ws_open_control_connection (server, connection);
    }
  else if (g_str_has_prefix (resource, "/client/"))
    {
      uint32_t client_id;
      sscanf (resource, "/client/%d", &client_id);
      ws_open_client_connection (server, connection, client_id);
    }
  else if (g_str_has_prefix (resource, "/fd/"))
    {
      uint32_t fd_id;
      sscanf (resource, "/fd/%d", &fd_id);
      ws_open_fd_connection (server, connection, fd_id);
    }
}

static gboolean
ws_on_incoming (GThreadedSocketService *service,
                GSocketConnection *connection,
                GObject *source_object,
                gpointer user_data)
{
  PeabodyServer *server = user_data;

  WebSocketConnection *web_socket;
  const char *protocols[] = { "peabody", NULL };

  web_socket = web_socket_server_new_for_stream ("whatever", NULL, protocols,
                                                 G_IO_STREAM (connection), NULL, NULL);
  g_signal_connect (web_socket, "open", G_CALLBACK (ws_on_connection_open), server);
  return TRUE;
}

static void
ws_open_socket (PeabodyServer *server)
{
  GSocketService *service;

  service = g_socket_service_new ();
  g_socket_listener_add_inet_port (G_SOCKET_LISTENER (service), 8080, NULL, NULL);
  g_signal_connect (service, "incoming", G_CALLBACK (ws_on_incoming), server);
}

static void
ws_control_send_new_client (PeabodyServer *server,
                            WaylandClient *client)
{
  char *msg = g_strdup_printf ("/client/%d", client->client_id);

  web_socket_connection_send (server->control_connection, WEB_SOCKET_DATA_TEXT, NULL,
                              g_bytes_new_take (msg, strlen (msg)));
}

static gboolean
wl_on_incoming (GThreadedSocketService *service,
                GSocketConnection *connection,
                GObject *source_object,
                gpointer user_data)
{
  PeabodyServer *server = user_data;
  WaylandClient *client = g_slice_new0 (WaylandClient);

  client->server = server;
  client->client_id = ++server->client_id_count;
  client->wl_connection = g_object_ref (connection);

  g_hash_table_insert (server->clients, &client->client_id, client);

  /* Send our control message */
  ws_control_send_new_client (server, client);

  return TRUE;
}

static char *
get_socket_path (void)
{
  return g_strconcat (g_getenv ("XDG_RUNTIME_DIR"), "/wayland-0", NULL);
}

static void
wl_open_socket (PeabodyServer *server)
{
  GSocketService *service;
  GSocketAddress *address;

  service = g_socket_service_new ();

  char *path = get_socket_path ();
  unlink (path);
  address = g_unix_socket_address_new (path);
  g_free (path);

  GError *error = NULL;
  if (!g_socket_listener_add_address (G_SOCKET_LISTENER (service),
                                      address,
                                      G_SOCKET_TYPE_STREAM,
                                      G_SOCKET_PROTOCOL_DEFAULT,
                                      NULL, NULL, &error))
    {
      g_print ("%s\n", error->message);
      return;
    }

  g_signal_connect (service, "incoming", G_CALLBACK (wl_on_incoming), server);
}

PeabodyServer *
peabody_server_new (void)
{
  PeabodyServer *server = g_slice_new0 (PeabodyServer);

  server->clients = g_hash_table_new (g_int_hash, g_int_equal);

  return server;
}

void
peabody_server_run (PeabodyServer *server)
{
  ws_open_socket (server);
  wl_open_socket (server);
}
