{{/*
Chart name and version, as used by the helm.sh/chart label.
*/}}
{{- define "parcelpigeon.chart" -}}
{{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Selector labels for one component. Keeps the `app: <name>` label the raw
manifests used, so Services keep matching their pods.
Usage: {{ include "parcelpigeon.selectorLabels" "gateway" }}
*/}}
{{- define "parcelpigeon.selectorLabels" -}}
app: {{ . }}
{{- end }}

{{/*
Common labels for one component.
Usage: {{ include "parcelpigeon.labels" (dict "name" "gateway" "ctx" $) }}
*/}}
{{- define "parcelpigeon.labels" -}}
{{ include "parcelpigeon.selectorLabels" .name }}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/part-of: parcelpigeon
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ include "parcelpigeon.chart" .ctx }}
{{- end }}
