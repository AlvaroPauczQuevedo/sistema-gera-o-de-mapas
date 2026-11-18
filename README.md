# Gêmeos Digitais Regionais — Fase 1 (em andamento)

Municípios: Serafina Corrêa, União da Serra, Montauri, Fagundes Varela, Veranópolis, Cotiporã.

Arquitetura gratuita e sem servidor: os dados são baixados por scripts Python, salvos como
GeoJSON em `frontend/public/data/` e exibidos por um site estático (React + CesiumJS).

## Rodar localmente
    cd frontend && npm install && npm run dev      # http://localhost:5173

Relevo 3D: crie um token gratuito em https://ion.cesium.com e coloque em `frontend/.env`:

    VITE_CESIUM_TOKEN=seu_token

Sem token, o mapa funciona, mas sem relevo.

## Atualizar os dados
    cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt shapely
    .venv/Scripts/python scripts/fetch_boundaries.py   # limites IBGE
    .venv/Scripts/python scripts/fetch_osm.py          # ruas, rios, edificações (OSM); --refazer para baixar tudo de novo

Novo município: incluir em `backend/app/municipios.py` e `frontend/public/data/municipios.json`, e rodar os scripts.

## Publicar (GitHub Pages, gratuito)
1. Envie o repositório ao GitHub.
2. Settings > Pages > Source: **GitHub Actions**.
3. Settings > Secrets and variables > Actions: crie `VITE_CESIUM_TOKEN`.
   No Cesium ion, restrinja o token ao domínio do site (o token fica visível no navegador).

## Fontes
| Camada | Fonte | Licença |
|---|---|---|
| Limites municipais | IBGE, API de Malhas v3 (qualidade máxima) | CC BY 4.0 |
| Vias, rios, edificações | OpenStreetMap (Overpass API) | ODbL 1.0 |
| Relevo | Cesium World Terrain (plano gratuito) | termos Cesium ion |

A cobertura do OSM é incompleta, sobretudo de edificações na zona rural. O que não está no OSM não aparece no mapa.

## Status
Feito: limites, vias, rios e edificações dos 6 municípios; mapa 3D com camadas, seleção de objetos e procedência.
Pendente: DEM próprio, declividade, instituições/abrigos, monitoramento (INMET/ANA/CEMADEN), simulações (HEC-RAS/HMS/SWMM), vistorias, relatórios, autenticação.
