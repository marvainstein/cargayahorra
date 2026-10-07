# Certificados intermedios

`www.axionenergy.com` no envía el certificado intermedio de su cadena TLS (los
navegadores lo descargan solos; Node no). Para poder validar la conexión **sin
desactivar la verificación**, se incluye ese intermedio público y se carga con
`NODE_EXTRA_CA_CERTS` (ver `package.json` y `Dockerfile`).

| Archivo | Sujeto | Emisor (raíz ya confiada por el sistema) | Vence | SHA-256 |
|---|---|---|---|---|
| `digicert-global-g2-tls-rsa-sha256-2020-ca1.pem` | DigiCert Global G2 TLS RSA SHA256 2020 CA1 | DigiCert Global Root G2 | 2031-03-29 | `C8:02:5F:9F:C6:5F:DF:C9:5B:3C:A8:CC:78:67:B9:A5:87:B5:27:79:73:95:79:17:46:3F:C8:13:D0:B6:25:A9` |

Origen: https://cacerts.digicert.com/DigiCertGlobalG2TLSRSASHA2562020CA1-1.crt
(verificado con `openssl verify` contra las raíces del sistema).

Un intermedio sólo sirve para completar cadenas que terminan en una raíz que el
sistema ya confía; no agrega ninguna raíz nueva.
