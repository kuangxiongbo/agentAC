#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

typedef void (*edge_menubar_action_fn)(const char *id);

void edge_menubar_set_action_handler(edge_menubar_action_fn handler);

/// `as_template`: true = 随菜单栏深浅变色；false = 彩色固定（更易看见）
void edge_menubar_install_png(const uint8_t *rgba, size_t len, uint32_t width, uint32_t height,
                              bool as_template);

void edge_menubar_refresh_visible(void);

void edge_menubar_log_geometry(char *buf, size_t buflen);

void edge_menubar_log_environment(char *buf, size_t buflen);
