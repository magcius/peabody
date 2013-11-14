# This file is part of Cockpit.
#
# Copyright (C) 2013 Red Hat, Inc.
#
# Cockpit is free software; you can redistribute it and/or modify it
# under the terms of the GNU Lesser General Public License as published by
# the Free Software Foundation; either version 2.1 of the License, or
# (at your option) any later version.
#
# Cockpit is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
# Lesser General Public License for more details.
#
# You should have received a copy of the GNU Lesser General Public License
# along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
AC_INIT([Cockpit],[0.2],[devel@lists.cockpit-project.org],[cockpit],[http://www.cockpit-project.org/])

AC_CONFIG_HEADERS([config.h])

AM_INIT_AUTOMAKE([1.9 foreign dist-bzip2 no-dist-gzip serial-tests])
AM_MAINTAINER_MODE([enable])

AC_USE_SYSTEM_EXTENSIONS

AC_PROG_CC
AC_PROG_CC_C99
AC_ISC_POSIX
AC_HEADER_STDC
AC_PROG_LIBTOOL

m4_ifdef([AM_SILENT_RULES], [AM_SILENT_RULES([yes])])

# Initialization

GOBJECT_INTROSPECTION_CHECK([0.6.2])

GIO_REQUIREMENT="gio-unix-2.0 >= 2.34"

PKG_CHECK_MODULES(GIO, [gio-unix-2.0 >= 2.34.0])
AC_SUBST(GIO_CFLAGS)
AC_SUBST(GIO_LIBS)

AC_OUTPUT([
Makefile
])
