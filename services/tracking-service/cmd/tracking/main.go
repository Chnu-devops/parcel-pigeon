package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/parcelpigeon/tracking-service/internal/config"
	"github.com/parcelpigeon/tracking-service/internal/consumer"
	"github.com/parcelpigeon/tracking-service/internal/httpapi"
	"github.com/parcelpigeon/tracking-service/internal/notify"
	"github.com/parcelpigeon/tracking-service/internal/store"
	"github.com/parcelpigeon/tracking-service/internal/upstream"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log) // the metrics middleware writes access logs through it
	cfg := config.Load()

	rdb := store.NewRedisStore(cfg.RedisAddr)
	api := &httpapi.API{
		Store:    rdb,
		Fallback: upstream.New(cfg.ShipmentsURL),
		Log:      log,
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           api.Router(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if cfg.EnableConsumer {
		cons := &consumer.Consumer{
			URL:      cfg.RabbitURL,
			Exchange: cfg.Exchange,
			Queue:    cfg.Queue,
			Store:    rdb,
			Mailer:   notify.NewMailer(cfg.SMTPAddr, cfg.MailFrom),
			Log:      log,
		}
		go cons.Run(ctx)
	}

	go func() {
		log.Info("http listening", "addr", cfg.HTTPAddr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
