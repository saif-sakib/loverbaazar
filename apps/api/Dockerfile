FROM golang:1.25-alpine AS b
WORKDIR /s
COPY . .
RUN CGO_ENABLED=0 go build -ldflags='-s -w' -o /server .
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=b /server /server
ENTRYPOINT ["/server"]
