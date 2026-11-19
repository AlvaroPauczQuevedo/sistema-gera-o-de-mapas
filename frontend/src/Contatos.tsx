import { useEffect, useState } from "react";

interface Orgao { nome: string; categoria_site: string; secretaria?: string | null; endereco?: string | null;
  telefone?: string | null; atendimento?: string | null; url: string; geolocalizacao: string }
interface Dados { orgaos: Orgao[]; fonte: { nome: string; url: string; obtido_em: string; situacao: string } }

/** Contatos institucionais coletados do site oficial da prefeitura (aba Informações, município selecionado). */
export function ContatosPrefeitura({ codigo }: { codigo: number }) {
  const [d, setD] = useState<Dados | null>(null);
  const [todos, setTodos] = useState(false);
  useEffect(() => {
    setD(null);
    fetch(`${import.meta.env.BASE_URL}data/${codigo}/prefeitura.json`).then((r) => (r.ok ? r.json() : null)).then(setD).catch(() => setD(null));
  }, [codigo]);
  if (!d) return null;
  const lista = todos ? d.orgaos : d.orgaos.slice(0, 8);
  return (<>
    <h2 style={{ marginTop: 16 }}>Contatos da prefeitura</h2>
    {d.fonte.situacao !== "ok" ? (
      <p className="muted">O site da prefeitura não permite coleta automática ({d.fonte.situacao.replace(/^site inacessível para coleta automática /, "")}).
        Consulte <a href={d.fonte.url} target="_blank" rel="noreferrer">{d.fonte.url.replace("https://", "")}</a> ou cadastre os
        órgãos pela aba Campo. Unidades de saúde: camada CNES.</p>
    ) : (<>
      {lista.map((o) => (
        <div key={o.url} className="contato">
          <b>{o.nome}</b> <span className="tag">{o.categoria_site}</span>
          {o.telefone && <div>☎ <a href={`tel:${o.telefone.replace(/[^\d]/g, "").slice(0, 11)}`}>{o.telefone}</a></div>}
          {o.endereco && <div className="muted">{o.endereco}</div>}
          {o.atendimento && <div className="muted">{o.atendimento}</div>}
          <div className="muted">{o.geolocalizacao.startsWith("não") ? "fora do mapa: endereço não localizado" : "no mapa (posição aproximada)"} ·{" "}
            <a href={o.url} target="_blank" rel="noreferrer">página oficial</a></div>
        </div>))}
      {d.orgaos.length > 8 && <button className="link" onClick={() => setTodos(!todos)}>{todos ? "mostrar menos" : `mostrar todos (${d.orgaos.length})`}</button>}
    </>)}
    <p className="muted">Fonte: {d.fonte.nome}, coletado em {new Date(d.fonte.obtido_em).toLocaleDateString("pt-BR")}.
      Confirme os contatos antes de uso operacional.</p>
  </>);
}
